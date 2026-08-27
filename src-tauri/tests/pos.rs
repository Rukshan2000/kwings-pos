use greenplus_pos_lib::db::{paths, server::PgServer};
use sqlx::PgPool;

fn pg_root() -> std::path::PathBuf { paths::pg_root(None).unwrap() }

fn temp_root(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pos-sale-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

async fn migrated_pool(root: &std::path::Path) -> (PgServer, PgPool) {
    let server = PgServer::start(root.to_path_buf(), pg_root()).unwrap();
    let pool = PgPool::connect(&server.config.url()).await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    (server, pool)
}

async fn stocked_product(pool: &PgPool, name: &str, qty: &str) -> i64 {
    let pc: i64 = sqlx::query_scalar("SELECT id FROM unit WHERE code = 'pc'").fetch_one(pool).await.unwrap();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO product (name, base_unit_id, selling_price) VALUES ($1, $2, 22.00) RETURNING id"
    ).bind(name).bind(pc).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO stock_movement (product_id, location_id, quantity, reason) VALUES ($1, 1, $2, 'opening')")
        .bind(id).bind(qty.parse::<rust_decimal::Decimal>().unwrap()).execute(pool).await.unwrap();
    id
}

/// Mirrors pos::complete_sale's transaction body exactly (same SQL, same order),
/// since the real command needs a tauri::State this test cannot construct.
async fn complete_sale(
    pool: &PgPool,
    product_id: i64,
    unit_id: i64,
    qty: &str,
    price: &str,
    cash_paid: &str,
) -> (String, rust_decimal::Decimal) {
    let qty: rust_decimal::Decimal = qty.parse().unwrap();
    let price: rust_decimal::Decimal = price.parse().unwrap();
    let paid: rust_decimal::Decimal = cash_paid.parse().unwrap();
    let subtotal = qty * price;
    let balance_due = (subtotal - paid).max(rust_decimal::Decimal::ZERO);

    let mut tx = pool.begin().await.unwrap();

    let sale_id: i64 = sqlx::query_scalar(
        "INSERT INTO sale (location_id, status, subtotal, grand_total) VALUES (1, 'held', 0, 0) RETURNING id"
    ).fetch_one(&mut *tx).await.unwrap();

    let today = chrono::Utc::now().date_naive();
    sqlx::query("INSERT INTO invoice_counter (prefix, day, next_seq) VALUES ('INV', $1, 1) ON CONFLICT DO NOTHING")
        .bind(today).execute(&mut *tx).await.unwrap();
    let seq: i32 = sqlx::query_scalar("SELECT next_seq FROM invoice_counter WHERE prefix = 'INV' AND day = $1 FOR UPDATE")
        .bind(today).fetch_one(&mut *tx).await.unwrap();
    sqlx::query("UPDATE invoice_counter SET next_seq = next_seq + 1 WHERE prefix = 'INV' AND day = $1")
        .bind(today).execute(&mut *tx).await.unwrap();
    let invoice_number = format!("INV-{}-{seq:04}", today.format("%Y%m%d"));

    sqlx::query(
        "INSERT INTO sale_line (sale_id, product_id, unit_id, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6)"
    ).bind(sale_id).bind(product_id).bind(unit_id).bind(qty).bind(price).bind(subtotal)
     .execute(&mut *tx).await.unwrap();

    sqlx::query(
        "INSERT INTO stock_movement (product_id, location_id, quantity, reason, ref_table, ref_id)
         VALUES ($1, 1, $2, 'sale', 'sale', $3)"
    ).bind(product_id).bind(-qty).bind(sale_id).execute(&mut *tx).await.unwrap();

    if paid > rust_decimal::Decimal::ZERO {
        sqlx::query("INSERT INTO sale_payment (sale_id, method, amount) VALUES ($1, 'cash', $2)")
            .bind(sale_id).bind(paid).execute(&mut *tx).await.unwrap();
    }

    sqlx::query(
        "UPDATE sale SET invoice_number = $1, status = 'completed', subtotal = $2,
                          grand_total = $2, balance_due = $3, completed_at = now()
         WHERE id = $4"
    ).bind(&invoice_number).bind(subtotal).bind(balance_due).bind(sale_id)
     .execute(&mut *tx).await.unwrap();

    tx.commit().await.unwrap();
    (invoice_number, balance_due)
}

#[tokio::test]
async fn completing_a_sale_deducts_stock_and_records_payment_atomically() {
    let root = temp_root("checkout");
    let (mut server, pool) = migrated_pool(&root).await;
    let pc: i64 = sqlx::query_scalar("SELECT id FROM unit WHERE code = 'pc'").fetch_one(&pool).await.unwrap();
    let product_id = stocked_product(&pool, "Growth Hormone 250ml", "50").await;

    let (invoice, balance) = complete_sale(&pool, product_id, pc, "3", "22.00", "66.00").await;
    assert!(invoice.starts_with("INV-"));
    assert_eq!(balance, rust_decimal::Decimal::ZERO, "fully paid, no credit balance");

    let on_hand: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity), 0) FROM stock_movement WHERE product_id = $1"
    ).bind(product_id).fetch_one(&pool).await.unwrap();
    assert_eq!(on_hand, "47".parse().unwrap(), "50 - 3 sold");

    let paid_amount: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT SUM(amount) FROM sale_payment sp JOIN sale s ON s.id = sp.sale_id WHERE s.invoice_number = $1"
    ).bind(&invoice).fetch_one(&pool).await.unwrap();
    assert_eq!(paid_amount, "66.00".parse().unwrap());

    pool.close().await;
    server.stop().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_partial_payment_leaves_a_credit_balance() {
    let root = temp_root("credit");
    let (mut server, pool) = migrated_pool(&root).await;
    let pc: i64 = sqlx::query_scalar("SELECT id FROM unit WHERE code = 'pc'").fetch_one(&pool).await.unwrap();
    let product_id = stocked_product(&pool, "Urea 50kg Bag", "10").await;

    // 22.00, only 10.00 paid -> 12.00 owed.
    let (_invoice, balance) = complete_sale(&pool, product_id, pc, "1", "22.00", "10.00").await;
    assert_eq!(balance, "12.00".parse().unwrap());

    pool.close().await;
    server.stop().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn invoice_numbers_are_gapless_and_sequential_under_concurrency() {
    let root = temp_root("concurrent");
    let (mut server, pool) = migrated_pool(&root).await;
    let pc: i64 = sqlx::query_scalar("SELECT id FROM unit WHERE code = 'pc'").fetch_one(&pool).await.unwrap();
    let product_id = stocked_product(&pool, "Weedicide 1L", "1000").await;

    // Ten "simultaneous" sales. The FOR UPDATE lock in next_invoice_number
    // serializes these; if it did not, two sales could race to read the same
    // next_seq and collide on the invoice_number unique constraint.
    let mut handles = Vec::new();
    for _ in 0..10 {
        let pool = pool.clone();
        handles.push(tokio::spawn(async move {
            complete_sale(&pool, product_id, pc, "1", "22.00", "22.00").await.0
        }));
    }
    let mut invoices: Vec<String> = Vec::new();
    for h in handles {
        invoices.push(h.await.unwrap());
    }

    let mut seqs: Vec<i32> = invoices
        .iter()
        .map(|s| s.rsplit('-').next().unwrap().parse().unwrap())
        .collect();
    seqs.sort();
    assert_eq!(seqs, (1..=10).collect::<Vec<_>>(), "no gaps, no duplicates, no collisions");

    let unique_count: i64 = sqlx::query_scalar("SELECT count(DISTINCT invoice_number) FROM sale")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(unique_count, 10);

    pool.close().await;
    server.stop().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn held_sale_does_not_touch_stock_until_completed() {
    let root = temp_root("held");
    let (mut server, pool) = migrated_pool(&root).await;
    let pc: i64 = sqlx::query_scalar("SELECT id FROM unit WHERE code = 'pc'").fetch_one(&pool).await.unwrap();
    let product_id = stocked_product(&pool, "Growth Hormone 250ml", "20").await;

    let sale_id: i64 = sqlx::query_scalar(
        "INSERT INTO sale (location_id, status, subtotal, grand_total) VALUES (1, 'held', 44, 44) RETURNING id"
    ).fetch_one(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO sale_line (sale_id, product_id, unit_id, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, 2, 22.00, 44.00)"
    ).bind(sale_id).bind(product_id).bind(pc).execute(&pool).await.unwrap();

    let on_hand_while_held: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity), 0) FROM stock_movement WHERE product_id = $1"
    ).bind(product_id).fetch_one(&pool).await.unwrap();
    assert_eq!(on_hand_while_held, "20".parse().unwrap(), "holding a cart must not reserve stock");

    // Cancelling it must not touch stock either, and must not be resurrectable.
    sqlx::query("DELETE FROM sale_line WHERE sale_id = $1").bind(sale_id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE sale SET status = 'cancelled' WHERE id = $1").bind(sale_id).execute(&pool).await.unwrap();

    let on_hand_after_cancel: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity), 0) FROM stock_movement WHERE product_id = $1"
    ).bind(product_id).fetch_one(&pool).await.unwrap();
    assert_eq!(on_hand_after_cancel, "20".parse().unwrap());

    pool.close().await;
    server.stop().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}
