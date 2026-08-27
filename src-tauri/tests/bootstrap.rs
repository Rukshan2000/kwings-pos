//! End-to-end check of the PostgreSQL bootstrap: initdb, start, migrate, back up,
//! stop, and leave nothing running.
//!
//! Requires the bundled binaries — run `node scripts/fetch-postgres.mjs` first.

use std::net::TcpListener;
use std::path::PathBuf;

use greenplus_pos_lib::db::config::DB_USER;
use greenplus_pos_lib::db::{backup, paths, server::PgServer};

fn pg_root() -> PathBuf {
    paths::pg_root(None).expect("run `node scripts/fetch-postgres.mjs` first")
}

/// Unique per run so a failed test never poisons the next one.
fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pos-test-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[test]
fn bootstrap_migrate_backup_and_shutdown() {
    let root = temp_root("full");
    let mut server = PgServer::start(root.clone(), pg_root()).expect("server should start");
    let port = server.config.port;

    assert!(!port_free(port), "server should be listening on {port}");

    // The application database exists, not just the maintenance one.
    let out = server
        .psql("pos", "SELECT current_database()")
        .expect("psql should work");
    assert_eq!(out.trim(), "pos");

    // Migrations apply, and the seeded row from 0001 is there.
    let rt = tokio::runtime::Runtime::new().unwrap();
    let pool = rt.block_on(async {
        let pool = sqlx::PgPool::connect(&server.config.url()).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    });

    let currency: String = rt.block_on(async {
        sqlx::query_scalar("SELECT value #>> '{}' FROM app_setting WHERE key = 'currency'")
            .fetch_one(&pool)
            .await
            .unwrap()
    });
    assert_eq!(currency, "LKR");

    // Migrations are forward-only and idempotent: a second run is a no-op.
    rt.block_on(async {
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    });

    // Backup produces a real, non-empty dump.
    let dest = root.join("backups");
    let file = backup::dump(
        &pg_root(),
        &root,
        port,
        DB_USER,
        &server.config.password,
        &dest,
    )
    .expect("backup should succeed");
    assert!(file.metadata().unwrap().len() > 0, "dump must not be empty");

    rt.block_on(pool.close());
    server.stop().expect("clean shutdown");
    drop(server);

    assert!(port_free(port), "no postgres should survive shutdown");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn restart_reuses_the_existing_cluster() {
    let root = temp_root("restart");

    let mut first = PgServer::start(root.clone(), pg_root()).expect("first start");
    let password = first.config.password.clone();
    first
        .psql("pos", "CREATE TABLE persisted (id int PRIMARY KEY)")
        .unwrap();
    first.stop().unwrap();
    drop(first);

    let mut second = PgServer::start(root.clone(), pg_root()).expect("second start");
    // Same generated password: regenerating it would lock us out of our own cluster.
    assert_eq!(second.config.password, password);

    let found = second
        .psql(
            "pos",
            "SELECT 1 FROM information_schema.tables WHERE table_name = 'persisted'",
        )
        .unwrap();
    assert_eq!(found.trim(), "1", "data must survive a restart");

    second.stop().unwrap();
    drop(second);
    let _ = std::fs::remove_dir_all(&root);
}

/// A `postmaster.pid` left behind by a killed server must not block startup.
#[test]
fn stale_pidfile_is_cleared() {
    let root = temp_root("stale");

    let mut server = PgServer::start(root.clone(), pg_root()).expect("first start");
    server.stop().unwrap();
    drop(server);

    let pidfile = paths::data_dir(&root).join("postmaster.pid");
    std::fs::write(&pidfile, "99999\n/nonexistent\n0\n1\n").unwrap();

    let mut server = PgServer::start(root.clone(), pg_root())
        .expect("a stale pidfile should not block startup");
    server.stop().unwrap();
    drop(server);

    let _ = std::fs::remove_dir_all(&root);
}
