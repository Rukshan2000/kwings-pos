use std::path::PathBuf;

use serde::Serialize;
use tauri::{Manager, State};

use crate::db::config::{DB_NAME, DB_USER};
use crate::db::{backup, AppDb, BootstrapError, Db, DbError};

/// What the app knows about its own database. Shown in Settings so a shop owner
/// can read something useful to us over the phone.
#[derive(Serialize)]
pub struct DbHealth {
    pub connected: bool,
    pub server_version: String,
    pub port: u16,
    pub database: String,
    pub data_dir: Option<String>,
    pub migrations: i64,
    pub latest_migration: Option<String>,
}

/// Non-failing readiness probe the UI can poll while bootstrap runs.
#[derive(Serialize)]
pub struct DbStatus {
    pub ready: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn db_status(
    state: State<'_, AppDb>,
    bootstrap_error: State<'_, BootstrapError>,
) -> Result<DbStatus, DbError> {
    Ok(DbStatus {
        ready: state.0.read().await.is_some(),
        error: bootstrap_error.0.read().await.clone(),
    })
}

#[tauri::command]
pub async fn db_health(state: State<'_, AppDb>) -> Result<DbHealth, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    let version: String = sqlx::query_scalar("SHOW server_version")
        .fetch_one(&db.pool)
        .await?;

    let (migrations, latest): (i64, Option<i64>) = sqlx::query_as(
        "SELECT count(*), max(version) FROM _sqlx_migrations WHERE success",
    )
    .fetch_one(&db.pool)
    .await?;

    let latest_migration = match latest {
        Some(v) => sqlx::query_scalar("SELECT description FROM _sqlx_migrations WHERE version = $1")
            .bind(v)
            .fetch_optional(&db.pool)
            .await?,
        None => None,
    };

    Ok(DbHealth {
        connected: true,
        server_version: version,
        port: db.port(),
        database: DB_NAME.to_string(),
        data_dir: db.data_root().map(|p| p.display().to_string()),
        migrations,
        latest_migration,
    })
}

#[tauri::command]
pub async fn backup_now(app: tauri::AppHandle, state: State<'_, AppDb>) -> Result<String, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    let dest = backup_dir(&app, db);
    let pg_root = db.pg_root().ok_or(DbError::NoDataDir)?;
    let data_root = db.data_root().ok_or(DbError::NoDataDir)?;
    let port = db.port();

    // The password lives with the server config, not in this layer.
    let password = db
        .database_url()
        .and_then(|url| extract_password(&url))
        .ok_or(DbError::NoDataDir)?;

    let path = tokio::task::spawn_blocking(move || {
        backup::dump(&pg_root, &data_root, port, DB_USER, &password, &dest)
    })
    .await
    .map_err(|e| DbError::Backup(format!("backup task panicked: {e}")))??;

    Ok(path.display().to_string())
}

fn backup_dir(app: &tauri::AppHandle, db: &Db) -> PathBuf {
    app.path()
        .document_dir()
        .map(|d| d.join("GreenPlusPOS Backups"))
        .unwrap_or_else(|_| {
            db.data_root()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("backups")
        })
}

/// `postgres://user:PASSWORD@host/db` → the percent-decoded password.
fn extract_password(url: &str) -> Option<String> {
    let after_scheme = url.split("://").nth(1)?;
    let creds = after_scheme.split('@').next()?;
    let encoded = creds.split(':').nth(1)?;
    Some(percent_decode(encoded))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
