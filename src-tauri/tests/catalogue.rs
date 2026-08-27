use greenplus_pos_lib::db::{paths, server::PgServer};
use sqlx::PgPool;

fn pg_root() -> std::path::PathBuf {
    paths::pg_root(None).unwrap()
}

fn temp_root(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pos-cat-{name}-{}", std::process::id()));
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
async fn product_lifecycle_and_unit_conversion_end_to_end() {
    let root = temp_root("lifecycle");
    let (mut server, pool) = migrated_pool(&root).await;

    let pc_unit: i64 = sqlx::query_scalar("SELECT id FROM unit WHERE code = 'pc'")
        .fetch_one(&pool).await.unwrap();
    let box_unit: i64 = sqlx::query_scalar("SELECT id FROM unit WHERE code = 'box'")
        .fetch_one(&pool).await.unwrap();

    // Create a product priced per piece with a box conversion.
    let product_id: i64 = sqlx::query_scalar(
        "INSERT INTO product (sku, name, base_unit_id, cost_price, selling_price)
         VALUES ('SKU-1', 'Growth Hormone 250ml', $1, 15.00, 22.00) RETURNING id"
    ).bind(pc_unit).fetch_one(&pool).await.unwrap();

    sqlx::query(
        "INSERT INTO product_unit (product_id, unit_id, factor) VALUES ($1, $2, 12)"
    ).bind(product_id).bind(box_unit).execute(&pool).await.unwrap();

    sqlx::query(
        "INSERT INTO product_price_tier (product_id, unit_id, kind, min_qty, price)
         VALUES ($1, $2, 'wholesale', 5, 240.00)"
    ).bind(product_id).bind(box_unit).execute(&pool).await.unwrap();

    // Duplicate SKU is rejected at the DB level (what map_unique_violation reads).
    let dup = sqlx::query(
        "INSERT INTO product (sku, name, base_unit_id) VALUES ('SKU-1', 'Other', $1)"
    ).bind(pc_unit).execute(&pool).await;
    let err = dup.unwrap_err();
    if let sqlx::Error::Database(e) = &err {
        assert_eq!(e.code().as_deref(), Some("23505"));
        assert!(e.constraint().unwrap_or("").contains("sku"));
    } else {
        panic!("expected a database unique violation, got {err:?}");
    }

    // A box costs 12x the piece factor — this is what the frontend will show as
    // "1 box = 12 pc" and what a purchase/sale line converts through.
    let factor: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT factor FROM product_unit WHERE product_id = $1 AND unit_id = $2"
    ).bind(product_id).bind(box_unit).fetch_one(&pool).await.unwrap();
    assert_eq!(factor, rust_decimal::Decimal::from(12));

    // Archiving is soft: the row survives, active flips false.
    sqlx::query("UPDATE product SET active = false, archived_at = now() WHERE id = $1")
        .bind(product_id).execute(&pool).await.unwrap();
    let (active, archived): (bool, Option<chrono::DateTime<chrono::Utc>>) = sqlx::query_as(
        "SELECT active, archived_at FROM product WHERE id = $1"
    ).bind(product_id).fetch_one(&pool).await.unwrap();
    assert!(!active);
    assert!(archived.is_some());

    pool.close().await;
    server.stop().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}
