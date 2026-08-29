//! A full CRUD SQL console for admins — ad hoc reads and edits across
//! products, categories, inventory, purchases, sales, etc. without waiting on
//! a screen to be built for every question or fix a shop owner might need.
//!
//! Opened as its own window (see `open_sql_console` in `lib.rs`), gated by a
//! password on the frontend and, for real, by this command re-checking the
//! admin role itself. A single statement only — no semicolon stacking — and
//! schema-changing statements (DROP/ALTER/CREATE/GRANT/...) are refused; this
//! is for editing rows, not the schema. TRUNCATE is the one exception: it
//! only empties tables, it doesn't touch their structure, and admins need it
//! for wiping test/demo data before a shop goes live.

use serde::Serialize;
use sqlx::FromRow;

use crate::auth::{require_role, SessionState};
use crate::db::{AppDb, DbError};

#[derive(Serialize)]
pub struct SqlQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<serde_json::Value>,
    pub rows_affected: Option<u64>,
}

#[derive(Serialize, FromRow)]
pub struct TableInfo {
    pub name: String,
    /// Postgres's own planner estimate (`pg_class.reltuples`), not an exact
    /// count — counting exactly would mean a full scan of every table just to
    /// populate a sidebar.
    pub row_estimate: i64,
}

#[derive(Serialize, FromRow)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
}

/// Every ordinary table in the app's own schema — a pgAdmin-style object list
/// for the console's sidebar.
#[tauri::command]
pub async fn list_sql_tables(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
) -> Result<Vec<TableInfo>, DbError> {
    require_role(&session, &["admin"]).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(sqlx::query_as(
        "SELECT c.relname AS name, GREATEST(c.reltuples, 0)::bigint AS row_estimate
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
         ORDER BY c.relname",
    )
    .fetch_all(&db.pool)
    .await?)
}

/// A table's columns, in declared order — shown above the results grid when
/// browsing a table, the way pgAdmin shows the schema alongside the data.
#[tauri::command]
pub async fn list_table_columns(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    table: String,
) -> Result<Vec<ColumnInfo>, DbError> {
    require_role(&session, &["admin"]).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(sqlx::query_as(
        "SELECT column_name AS name, data_type, (is_nullable = 'YES') AS is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position",
    )
    .bind(&table)
    .fetch_all(&db.pool)
    .await?)
}

const FORBIDDEN_KEYWORDS: &[&str] = &[
    "drop ", "alter ", "create ", "grant ", "revoke ", "vacuum ", "copy ",
];

/// A single SELECT/WITH/INSERT/UPDATE/DELETE/TRUNCATE statement — no
/// semicolon stacking, and nothing else that touches the schema or server
/// config.
fn validate_statement(sql: &str) -> Result<(), DbError> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err(DbError::Conflict("enter a query first".into()));
    }
    if trimmed.trim_end_matches(';').contains(';') {
        return Err(DbError::Conflict("only a single statement is allowed".into()));
    }
    let lower = trimmed.to_lowercase();
    let allowed_start = ["select", "with", "insert", "update", "delete", "truncate"]
        .iter()
        .any(|kw| lower.starts_with(kw));
    if !allowed_start {
        return Err(DbError::Conflict(
            "only SELECT, WITH, INSERT, UPDATE, DELETE, or TRUNCATE statements are allowed here".into(),
        ));
    }
    if let Some(kw) = FORBIDDEN_KEYWORDS.iter().find(|kw| lower.contains(*kw)) {
        return Err(DbError::Conflict(format!(
            "'{}' is not allowed here — this console edits rows, not the schema",
            kw.trim()
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn run_sql_query(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    sql: String,
) -> Result<SqlQueryResult, DbError> {
    require_role(&session, &["admin"]).await?;
    validate_statement(&sql)?;

    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let trimmed = sql.trim().trim_end_matches(';');
    let lower = trimmed.to_lowercase();
    let is_read = lower.starts_with("select") || lower.starts_with("with");
    let has_returning = lower.contains(" returning ") || lower.ends_with("returning");

    if is_read || has_returning {
        // Wrapping in row_to_json sidesteps needing to know each column's
        // type ahead of time — every shape of result comes back as one JSON
        // object per row. A data-modifying statement with RETURNING can be
        // wrapped the same way as a CTE, which Postgres allows.
        let wrapped = if is_read {
            format!("SELECT row_to_json(sql_console_row) AS row_json FROM ({trimmed}) sql_console_row LIMIT 500")
        } else {
            format!(
                "WITH sql_console_cte AS ({trimmed}) SELECT row_to_json(sql_console_cte) AS row_json FROM sql_console_cte LIMIT 500"
            )
        };

        let rows: Vec<(serde_json::Value,)> = sqlx::query_as(&wrapped)
            .fetch_all(&db.pool)
            .await
            .map_err(DbError::from)?;

        let rows: Vec<serde_json::Value> = rows.into_iter().map(|(v,)| v).collect();
        let columns = rows
            .first()
            .and_then(|v| v.as_object())
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        let rows_affected = if is_read { None } else { Some(rows.len() as u64) };

        Ok(SqlQueryResult { columns, rows, rows_affected })
    } else {
        let result = sqlx::query(trimmed)
            .execute(&db.pool)
            .await
            .map_err(DbError::from)?;
        Ok(SqlQueryResult { columns: vec![], rows: vec![], rows_affected: Some(result.rows_affected()) })
    }
}
