//! Stock: the append-only movement ledger, current-stock views, adjustments, and
//! valuation. Phase 4.
//!
//! Current stock is never a stored column — it is always `sum(quantity)` over
//! `stock_movement` for a product/location, which is what makes the ledger the
//! single source of truth instead of something that can drift out of sync with it.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::db::{AppDb, DbError};

#[derive(Serialize, FromRow)]
pub struct StockLevel {
    pub product_id: i64,
    pub product_name: String,
    pub sku: Option<String>,
    pub base_unit_code: String,
    pub on_hand: Decimal,
    pub low_stock_at: Decimal,
    pub cost_price: Decimal,
}

#[derive(Serialize, FromRow)]
pub struct StockMovementRow {
    pub id: i64,
    pub quantity: Decimal,
    pub reason: String,
    pub unit_cost: Option<Decimal>,
    pub note: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub created_by_name: Option<String>,
}

#[derive(Deserialize)]
pub struct AdjustmentInput {
    pub product_id: i64,
    /// Signed: positive adds stock, negative removes it. The reason is always
    /// recorded as `adjustment` — a movement never lies about why it happened.
    pub quantity: Decimal,
    pub reason_note: String,
}

#[derive(Deserialize)]
pub struct OpeningStockInput {
    pub product_id: i64,
    pub quantity: Decimal,
    pub unit_cost: Decimal,
}

fn default_location() -> i64 {
    // The MVP is single-location; every command uses the seeded default rather
    // than requiring the caller to know its id. Multi-location UI (phase-later)
    // will pass an explicit location_id instead of calling this.
    1
}

#[tauri::command]
pub async fn stock_levels(
    state: tauri::State<'_, AppDb>,
    low_stock_only: bool,
) -> Result<Vec<StockLevel>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let sql = format!(
        "SELECT p.id AS product_id, p.name AS product_name, p.sku,
                u.code AS base_unit_code,
                COALESCE(SUM(m.quantity), 0) AS on_hand,
                p.low_stock_at, p.cost_price
         FROM product p
         JOIN unit u ON u.id = p.base_unit_id
         LEFT JOIN stock_movement m ON m.product_id = p.id AND m.location_id = $1
         WHERE p.archived_at IS NULL
         GROUP BY p.id, p.name, p.sku, u.code, p.low_stock_at, p.cost_price
         {}
         ORDER BY p.name",
        if low_stock_only {
            // A threshold of 0 is the shop opting out: an out-of-stock item
            // sitting at 0 would otherwise be "low" forever.
            "HAVING p.low_stock_at > 0 AND COALESCE(SUM(m.quantity), 0) <= p.low_stock_at"
        } else {
            ""
        }
    );

    Ok(sqlx::query_as::<_, StockLevel>(&sql)
        .bind(default_location())
        .fetch_all(&db.pool)
        .await?)
}

#[tauri::command]
pub async fn stock_movements(
    state: tauri::State<'_, AppDb>,
    product_id: i64,
) -> Result<Vec<StockMovementRow>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    Ok(sqlx::query_as::<_, StockMovementRow>(
        "SELECT m.id, m.quantity, m.reason::text AS reason, m.unit_cost, m.note,
                m.created_at, u.display_name AS created_by_name
         FROM stock_movement m
         LEFT JOIN app_user u ON u.id = m.created_by
         WHERE m.product_id = $1
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 500",
    )
    .bind(product_id)
    .fetch_all(&db.pool)
    .await?)
}

/// Total on-hand cost across every product — sum of `on_hand * cost_price`. Uses
/// the product's *current* cost, which is the simplest valuation method and the
/// one the feature spec asks for; it is not a moving-average or FIFO valuation.
#[tauri::command]
pub async fn stock_valuation(state: tauri::State<'_, AppDb>) -> Result<Decimal, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let total: Option<Decimal> = sqlx::query_scalar(
        "SELECT SUM(on_hand * cost_price) FROM (
            SELECT p.id, COALESCE(SUM(m.quantity), 0) AS on_hand, p.cost_price
            FROM product p
            LEFT JOIN stock_movement m ON m.product_id = p.id
            WHERE p.archived_at IS NULL
            GROUP BY p.id, p.cost_price
         ) t",
    )
    .fetch_one(&db.pool)
    .await?;

    Ok(total.unwrap_or(Decimal::ZERO))
}

/// Opening stock is only meaningful once per product — recording it twice would
/// silently double the shop's real stock count, which is a much worse failure
/// than refusing the second attempt.
#[tauri::command]
pub async fn record_opening_stock(
    state: tauri::State<'_, AppDb>,
    input: OpeningStockInput,
) -> Result<(), DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM stock_movement WHERE product_id = $1 AND reason = 'opening')",
    )
    .bind(input.product_id)
    .fetch_one(&db.pool)
    .await?;
    if exists {
        return Err(DbError::Conflict(
            "opening stock has already been recorded for this product".into(),
        ));
    }

    sqlx::query(
        "INSERT INTO stock_movement (product_id, location_id, quantity, reason, unit_cost)
         VALUES ($1, $2, $3, 'opening', $4)",
    )
    .bind(input.product_id)
    .bind(default_location())
    .bind(input.quantity)
    .bind(input.unit_cost)
    .execute(&db.pool)
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn adjust_stock(
    state: tauri::State<'_, AppDb>,
    input: AdjustmentInput,
) -> Result<(), DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    sqlx::query(
        "INSERT INTO stock_movement (product_id, location_id, quantity, reason, note)
         VALUES ($1, $2, $3, 'adjustment', $4)",
    )
    .bind(input.product_id)
    .bind(default_location())
    .bind(input.quantity)
    .bind(input.reason_note.trim())
    .execute(&db.pool)
    .await?;

    Ok(())
}
