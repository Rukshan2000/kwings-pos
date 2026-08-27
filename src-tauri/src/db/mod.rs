pub mod backup;
pub mod commands;
pub mod config;
pub mod paths;
pub mod server;
pub mod winquote;
#[cfg(windows)]
pub mod winspawn;

use std::path::PathBuf;
use std::sync::Mutex;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use server::PgServer;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("bundled PostgreSQL binaries not found (looked in: {})", .0.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "))]
    BinariesMissing(Vec<PathBuf>),
    #[error("could not determine the application data directory")]
    NoDataDir,
    #[error("failed to launch a PostgreSQL tool: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("initdb failed: {0}")]
    InitDb(String),
    #[error("psql failed: {0}")]
    Psql(String),
    #[error("PostgreSQL exited during startup ({status})\n{log}")]
    Exited { status: String, log: String },
    #[error("PostgreSQL did not become ready in time\n{0}")]
    StartTimeout(String),
    #[error("another PostgreSQL is already using this data directory on port {0}")]
    AlreadyRunning(u16),
    #[error("data directory was created by PostgreSQL {cluster} but the bundled binaries are {binaries}")]
    VersionMismatch { cluster: String, binaries: String },
    #[error("job object error: {0}")]
    #[allow(dead_code)]
    Job(String),
    #[error("the database is still starting up")]
    NotReady,
    #[error("backup failed: {0}")]
    Backup(String),
    #[error("{0}")]
    Conflict(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error("migration failed: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

/// Tauri commands return strings to the frontend; the detail is preserved in the
/// message rather than a code, because every one of these is an install-level
/// problem a human has to read.
impl serde::Serialize for DbError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Bootstrap runs in the background so the window can paint immediately; every
/// command therefore has to cope with the database not being up yet.
pub struct AppDb(pub tokio::sync::RwLock<Option<Db>>);

impl AppDb {
    pub fn empty() -> Self {
        AppDb(tokio::sync::RwLock::new(None))
    }
}

/// Live database handle shared with every Tauri command.
pub struct Db {
    pub pool: PgPool,
    server: Mutex<Option<PgServer>>,
}

impl Db {
    /// Starts PostgreSQL, connects, and applies migrations. Called once at launch.
    pub async fn bootstrap(resource_dir: Option<PathBuf>) -> Result<Self, DbError> {
        let pg_root = paths::pg_root(resource_dir.as_deref())?;
        let root = paths::app_data_root()?;

        // Process spawning and initdb are blocking and can take tens of seconds on
        // first run; keep them off the async runtime's worker threads.
        let server = tokio::task::spawn_blocking(move || PgServer::start(root, pg_root))
            .await
            .map_err(|e| DbError::InitDb(format!("startup task panicked: {e}")))??;

        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(&server.config.url())
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;

        Ok(Db {
            pool,
            server: Mutex::new(Some(server)),
        })
    }

    pub fn port(&self) -> u16 {
        self.with_server(|s| s.config.port).unwrap_or(0)
    }

    pub fn pg_root(&self) -> Option<PathBuf> {
        self.with_server(|s| s.pg_root.clone())
    }

    pub fn data_root(&self) -> Option<PathBuf> {
        self.with_server(|s| s.root.clone())
    }

    pub fn database_url(&self) -> Option<String> {
        self.with_server(|s| s.config.url())
    }

    fn with_server<T>(&self, f: impl FnOnce(&PgServer) -> T) -> Option<T> {
        self.server.lock().ok()?.as_ref().map(f)
    }

    /// Closes the pool and stops the server. Idempotent.
    pub async fn shutdown(&self) {
        self.pool.close().await;
        if let Ok(mut guard) = self.server.lock() {
            if let Some(mut server) = guard.take() {
                let _ = server.stop();
            }
        }
    }
}
