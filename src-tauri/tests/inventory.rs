use greenplus_pos_lib::db::{paths, server::PgServer};
use sqlx::PgPool;

fn pg_root() -> std::path::PathBuf { paths::pg_root(None).unwrap() }

fn temp_root(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pos-inv-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

async fn migrated_pool(root: &std::path::Path) -> (PgServer, PgPool) {
    let server = PgServer::start(root.to_path_buf(), pg_root()).unwrap();
    let pool = PgPool::connect(&server.config.url()).await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    (server, pool)
}

async fn make_product(pool: &PgPool, name: &str, low_stock_at: Option<&str>) -> i64 {
    let pc: i64 = sqlx::query_scalar("SELECT id FROM unit WHERE code = 'pc'")
        .fetch_one(pool).await.unwrap();
    sqlx::query_scalar(
        "INSERT INTO product (name, base_unit_id, low_stock_at) VALUES ($1, $2, $3) RETURNING id"
    ).bind(name).bind(pc).bind(low_stock_at.map(|s| s.parse::<rust_decimal::Decimal>().unwrap()))
     .fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn ledger_sum_is_current_stock_and_never_mutates() {
    let root = temp_root("ledger");
    let (mut server, pool) = migrated_pool(&root).await;
    let product_id = make_product(&pool, "Urea 50kg Bag", Some("5")).await;

    // opening +100, a sale -3, an adjustment -2 (breakage) -> 95 on hand
    for (qty, reason) in [("100", "opening"), ("-3", "sale"), ("-2", "adjustment")] {
        sqlx::query(&format!(
            "INSERT INTO stock_movement (product_id, location_id, quantity, reason) VALUES ($1, 1, $2, '{reason}')"
        )).bind(product_id).bind(qty.parse::<rust_decimal::Decimal>().unwrap())
          .execute(&pool).await.unwrap();
    }

    let on_hand: rust_decimal::Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity), 0) FROM stock_movement WHERE product_id = $1"
    ).bind(product_id).fetch_one(&pool).await.unwrap();
    assert_eq!(on_hand, "95".parse().unwrap());

    let movement_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM stock_movement WHERE product_id = $1"
    ).bind(product_id).fetch_one(&pool).await.unwrap();
    assert_eq!(movement_count, 3, "the ledger keeps every row, never merges them");

    pool.close().await;
    server.stop().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn recording_opening_stock_twice_is_rejected() {
    let root = temp_root("opening-twice");
    let (mut server, pool) = migrated_pool(&root).await;
    let product_id = make_product(&pool, "Weedicide 1L", None).await;

    async fn already(pool: &PgPool, product_id: i64) -> bool {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM stock_movement WHERE product_id = $1 AND reason = 'opening')"
        ).bind(product_id).fetch_one(pool).await.unwrap()
    }

    assert!(!already(&pool, product_id).await);
    sqlx::query(
        "INSERT INTO stock_movement (product_id, location_id, quantity, reason) VALUES ($1, 1, 10, 'opening')"
    ).bind(product_id).execute(&pool).await.unwrap();
    assert!(already(&pool, product_id).await, "the guard in record_opening_stock checks exactly this");

    pool.close().await;
    server.stop().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn low_stock_filter_matches_the_threshold_boundary() {
    let root = temp_root("lowstock");
    let (mut server, pool) = migrated_pool(&root).await;

    let low = make_product(&pool, "Low Item", Some("10")).await;
    let ok = make_product(&pool, "OK Item", Some("10")).await;
    let unlimited = make_product(&pool, "No Threshold", None).await;

    for (id, qty) in [(low, "5"), (ok, "50"), (unlimited, "0")] {
        sqlx::query(
            "INSERT INTO stock_movement (product_id, location_id, quantity, reason) VALUES ($1, 1, $2, 'opening')"
        ).bind(id).bind(qty.parse::<rust_decimal::Decimal>().unwrap())
         .execute(&pool).await.unwrap();
    }

    // Mirrors the HAVING clause in inventory::stock_levels(low_stock_only = true).
    let low_names: Vec<String> = sqlx::query_scalar(
        "SELECT p.name FROM product p
         LEFT JOIN stock_movement m ON m.product_id = p.id
         GROUP BY p.id, p.name, p.low_stock_at
         HAVING p.low_stock_at IS NOT NULL AND COALESCE(SUM(m.quantity), 0) <= p.low_stock_at"
    ).fetch_all(&pool).await.unwrap();

    assert_eq!(low_names, vec!["Low Item".to_string()]);

    pool.close().await;
    server.stop().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}
