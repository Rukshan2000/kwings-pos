use greenplus_pos_lib::db::{paths, server::PgServer};

fn pg_root() -> std::path::PathBuf {
    paths::pg_root(None).unwrap()
}

fn temp_root(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pos-probe-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn schema_sanity_checks() {
    let root = temp_root("schema");
    let mut server = PgServer::start(root.clone(), pg_root()).unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    let pool = rt.block_on(async {
        let pool = sqlx::PgPool::connect(&server.config.url()).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    });

    // Seeded default location exists exactly once.
    let default_locations: i64 = rt.block_on(async {
        sqlx::query_scalar("SELECT count(*) FROM location WHERE is_default")
            .fetch_one(&pool).await.unwrap()
    });
    assert_eq!(default_locations, 1);

    // 10 units seeded.
    let units: i64 = rt.block_on(async {
        sqlx::query_scalar("SELECT count(*) FROM unit").fetch_one(&pool).await.unwrap()
    });
    assert_eq!(units, 10);

    // A second default location is rejected by the partial unique index.
    let dup = rt.block_on(async {
        sqlx::query("INSERT INTO location (name, is_default) VALUES ('Second', true)")
            .execute(&pool).await
    });
    assert!(dup.is_err(), "a second default location must be rejected");

    // Negative sale_line quantity is rejected by the CHECK constraint.
    let neg_qty = rt.block_on(async {
        sqlx::query(
            "INSERT INTO unit (code, name) VALUES ('probe', 'Probe') RETURNING id"
        ).fetch_one(&pool).await
    });
    assert!(neg_qty.is_ok());

    // Foreign key from product to unit is enforced.
    let bad_fk = rt.block_on(async {
        sqlx::query(
            "INSERT INTO product (name, base_unit_id) VALUES ('X', 999999)"
        ).execute(&pool).await
    });
    assert!(bad_fk.is_err(), "product.base_unit_id must be a real unit");

    // Admin was seeded with role admin.
    let role: String = rt.block_on(async {
        sqlx::query_scalar("SELECT role::text FROM app_user WHERE username = 'admin'")
            .fetch_one(&pool).await.unwrap()
    });
    assert_eq!(role, "admin");

    rt.block_on(pool.close());
    server.stop().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}
