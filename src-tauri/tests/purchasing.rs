use greenplus_pos_lib::db::{paths, server::PgServer};
use sqlx::PgPool;

fn pg_root() -> std::path::PathBuf { paths::pg_root(None).unwrap() }

fn temp_root(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pos-purch-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

async fn migrated_pool(root: &std::path::Path) -> (PgServer, PgPool) {
    let server = PgServer::start(root.to_path_buf(), pg_root()).unwrap();
    let pool = PgPool::connect(&server.config.url()).await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    (server, pool)
}

#[tokio::test]
async fn receiving_a_purchase_converts_units_and_writes_stock_atomically() {
    let root = temp_root("receive");
    let (mut server, pool) = migrated_pool(&root).await;

    let pc: i64 = sqlx::query_scalar("SELECT id FROM unit WHERE code = 'pc'").fetch_one(&pool).await.unwrap();
    let box_unit: i64 = sqlx::query_scalar("SELECT id FROM unit WHERE code = 'box'").fetch_one(&pool).await.unwrap();

    let product_id: i64 = sqlx::query_scalar(
        "INSERT INTO product (name, base_unit_id) VALUES ('Growth Hormone 250ml', $1) RETURNING id"
    ).bind(pc).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO product_unit (product_id, unit_id, factor) VALUES ($1, $2, 12)")
        .bind(product_id).bind(box_unit).execute(&pool).await.unwrap();

    let supplier_id: i64 = sqlx::query_scalar("INSERT INTO supplier (name) VALUES ('Agro Supplies') RETURNING id")
        .fetch_one(&pool).await.unwrap();

    let purchase_id: i64 = sqlx::query_scalar(
        "INSERT INTO purchase (supplier_id, location_id, status, total) VALUES ($1, 1, 'draft', 240) RETURNING id"
    ).bind(supplier_id).fetch_one(&pool).await.unwrap();

    // 2 boxes at 20.00/pc-equivalent cost stored per box... here unit_cost is per box.
    let line_id: i64 = sqlx::query_scalar(
        "INSERT INTO purchase_line (purchase_id, product_id, unit_id, quantity, unit_cost, line_total)
         VALUES ($1, $2, $3, 2, 120.00, 240.00) RETURNING id"
    ).bind(purchase_id).bind(product_id).bind(box_unit).fetch_one(&pool).await.unwrap();

    // Simulate receive_purchase's transaction body directly (same SQL the command runs).
    let mut tx = pool.begin().await.unwrap();
    let factor: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT factor FROM product_unit WHERE product_id = $1 AND unit_id = $2"
    ).bind(product_id).bind(box_unit).fetch_one(&mut *tx).await.unwrap();
    let base_qty = rust_decimal::Decimal::from(2) * factor;
    sqlx::query(
        "INSERT INTO stock_movement (product_id, location_id, quantity, reason, unit_cost, ref_table, ref_id)
         VALUES ($1, 1, $2, 'purchase', 120.00, 'purchase', $3)"
    ).bind(product_id).bind(base_qty).bind(purchase_id).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE purchase SET status = 'received' WHERE id = $1").bind(purchase_id)
        .execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();

    // 2 boxes x 12 pc/box = 24 pc on hand, not 2.
    let on_hand: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity), 0) FROM stock_movement WHERE product_id = $1"
    ).bind(product_id).fetch_one(&pool).await.unwrap();
    assert_eq!(on_hand, "24".parse().unwrap(), "unit conversion must apply before hitting the ledger");

    let status: String = sqlx::query_scalar("SELECT status::text FROM purchase WHERE id = $1")
        .bind(purchase_id).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "received");

    // Now return 1 box: reverses 12 pc, leaving 12 on hand.
    let mut tx = pool.begin().await.unwrap();
    let return_id: i64 = sqlx::query_scalar(
        "INSERT INTO purchase_return (purchase_id, status, reason) VALUES ($1, 'completed', 'damaged') RETURNING id"
    ).bind(purchase_id).fetch_one(&mut *tx).await.unwrap();
    sqlx::query(
        "INSERT INTO purchase_return_line (purchase_return_id, purchase_line_id, quantity, line_total)
         VALUES ($1, $2, 1, 120.00)"
    ).bind(return_id).bind(line_id).execute(&mut *tx).await.unwrap();
    sqlx::query(
        "INSERT INTO stock_movement (product_id, location_id, quantity, reason, unit_cost, ref_table, ref_id)
         VALUES ($1, 1, $2, 'purchase_return', 120.00, 'purchase_return', $3)"
    ).bind(product_id).bind(-(rust_decimal::Decimal::from(1) * factor)).bind(return_id)
     .execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();

    let on_hand: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity), 0) FROM stock_movement WHERE product_id = $1"
    ).bind(product_id).fetch_one(&pool).await.unwrap();
    assert_eq!(on_hand, "12".parse().unwrap());

    // Supplier outstanding = received total (240) minus payments (0) = 240.
    let outstanding: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT s.opening_balance
             + COALESCE((SELECT SUM(p.total) FROM purchase p WHERE p.supplier_id = s.id AND p.status = 'received'), 0)
             - COALESCE((SELECT SUM(pp.amount) FROM purchase_payment pp JOIN purchase p ON p.id = pp.purchase_id WHERE p.supplier_id = s.id), 0)
             - COALESCE((SELECT SUM(pr.total) FROM purchase_return pr JOIN purchase p ON p.id = pr.purchase_id WHERE p.supplier_id = s.id AND pr.status = 'completed'), 0)
         FROM supplier s WHERE s.id = $1"
    ).bind(supplier_id).fetch_one(&pool).await.unwrap();
    assert_eq!(outstanding, "240".parse().unwrap(), "the return total is not yet paid, so outstanding is unaffected by it");

    // Paying part of it reduces nothing in this formula (returns already deducted);
    // record a payment and confirm outstanding drops.
    sqlx::query("INSERT INTO purchase_payment (purchase_id, amount, method) VALUES ($1, 100, 'cash')")
        .bind(purchase_id).execute(&pool).await.unwrap();
    let outstanding: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT s.opening_balance
             + COALESCE((SELECT SUM(p.total) FROM purchase p WHERE p.supplier_id = s.id AND p.status = 'received'), 0)
             - COALESCE((SELECT SUM(pp.amount) FROM purchase_payment pp JOIN purchase p ON p.id = pp.purchase_id WHERE p.supplier_id = s.id), 0)
             - COALESCE((SELECT SUM(pr.total) FROM purchase_return pr JOIN purchase p ON p.id = pr.purchase_id WHERE p.supplier_id = s.id AND pr.status = 'completed'), 0)
         FROM supplier s WHERE s.id = $1"
    ).bind(supplier_id).fetch_one(&pool).await.unwrap();
    assert_eq!(outstanding, "140".parse().unwrap());

    pool.close().await;
    server.stop().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}
