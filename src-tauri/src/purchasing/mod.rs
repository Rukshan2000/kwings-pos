//! Suppliers, purchases, purchase payments, and purchase returns. Phase 5.
//!
//! Receiving a purchase is the one operation here that touches the stock ledger,
//! and it has to be all-or-nothing: every line's quantity converted to the
//! product's base unit and written as a `stock_movement` row, or none of it, in a
//! single transaction (per PLAN.md: "every stock-changing operation runs in a
//! transaction").

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::auth::SessionState;
use crate::db::{require_name, AppDb, DbError};

async fn require_signed_in(session: &tauri::State<'_, SessionState>) -> Result<(), DbError> {
    if session.0.read().await.as_ref().is_none() {
        return Err(DbError::Conflict("please sign in first".into()));
    }
    Ok(())
}

#[derive(Serialize, FromRow)]
pub struct Supplier {
    pub id: i64,
    pub name: String,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub outstanding: Decimal,
}

#[derive(Deserialize)]
pub struct SupplierInput {
    pub name: String,
    pub phone: Option<String>,
    pub address: Option<String>,
}

#[derive(Serialize, FromRow)]
pub struct Purchase {
    pub id: i64,
    pub supplier_id: i64,
    pub supplier_name: String,
    pub invoice_number: Option<String>,
    pub status: String,
    pub total: Decimal,
    pub paid: Decimal,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub received_at: Option<chrono::DateTime<chrono::Utc>>,
    pub line_count: i64,
    pub product_names: String,
}

#[derive(Serialize, FromRow)]
pub struct PurchaseLine {
    pub id: i64,
    pub product_id: i64,
    pub product_name: String,
    pub unit_id: i64,
    pub unit_code: String,
    pub quantity: Decimal,
    pub unit_cost: Decimal,
    pub line_total: Decimal,
}

#[derive(Serialize)]
pub struct PurchaseDetail {
    #[serde(flatten)]
    pub purchase: Purchase,
    pub lines: Vec<PurchaseLine>,
    pub payments: Vec<PurchasePaymentRow>,
}

#[derive(Serialize, FromRow)]
pub struct PurchasePaymentRow {
    pub id: i64,
    pub amount: Decimal,
    pub method: String,
    pub paid_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Deserialize)]
pub struct PurchaseLineInput {
    pub product_id: i64,
    pub unit_id: i64,
    pub quantity: Decimal,
    pub unit_cost: Decimal,
}

#[derive(Deserialize)]
pub struct ReturnLineInput {
    pub purchase_line_id: i64,
    pub quantity: Decimal,
}

#[derive(Deserialize)]
pub struct PurchaseInput {
    pub supplier_id: i64,
    pub invoice_number: Option<String>,
    pub lines: Vec<PurchaseLineInput>,
}

fn default_location() -> i64 {
    1
}

const SUPPLIER_SELECT: &str = "
    SELECT s.id, s.name, s.phone, s.address,
           s.opening_balance
             + COALESCE((SELECT SUM(p.total) FROM purchase p WHERE p.supplier_id = s.id AND p.status = 'received'), 0)
             - COALESCE((SELECT SUM(pp.amount) FROM purchase_payment pp JOIN purchase p ON p.id = pp.purchase_id WHERE p.supplier_id = s.id), 0)
             - COALESCE((SELECT SUM(pr.total) FROM purchase_return pr JOIN purchase p ON p.id = pr.purchase_id WHERE p.supplier_id = s.id AND pr.status = 'completed'), 0)
           AS outstanding
    FROM supplier s
    WHERE s.archived_at IS NULL
";

#[tauri::command]
pub async fn list_suppliers(state: tauri::State<'_, AppDb>) -> Result<Vec<Supplier>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(
        sqlx::query_as::<_, Supplier>(&format!("{SUPPLIER_SELECT} ORDER BY s.name"))
            .fetch_all(&db.pool)
            .await?,
    )
}

#[tauri::command]
pub async fn create_supplier(
    state: tauri::State<'_, AppDb>,
    input: SupplierInput,
) -> Result<Supplier, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    // Supplier names are not unique in the schema — two shops really can share a
    // name — so there is nothing to reject here beyond an empty one. Blank
    // contact fields are stored as NULL rather than "", so "no phone recorded"
    // and "phone recorded as nothing" cannot drift apart.
    let name = require_name(&input.name, "supplier")?;
    let blank_to_none = |v: Option<String>| v.filter(|s| !s.trim().is_empty()).map(|s| s.trim().to_string());

    let id: i64 = sqlx::query_scalar("INSERT INTO supplier (name, phone, address) VALUES ($1, $2, $3) RETURNING id")
        .bind(&name)
        .bind(blank_to_none(input.phone))
        .bind(blank_to_none(input.address))
        .fetch_one(&db.pool)
        .await?;

    Ok(
        sqlx::query_as::<_, Supplier>(&format!("{SUPPLIER_SELECT} AND s.id = $1"))
            .bind(id)
            .fetch_one(&db.pool)
            .await?,
    )
}

/// Soft delete only — a supplier may be referenced by historical purchases,
/// and hard-deleting it would corrupt that history.
#[tauri::command]
pub async fn archive_supplier(state: tauri::State<'_, AppDb>, id: i64) -> Result<(), DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    sqlx::query("UPDATE supplier SET archived_at = now() WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

async fn fetch_purchase(pool: &PgPool, id: i64) -> Result<Purchase, DbError> {
    Ok(sqlx::query_as(
        "SELECT p.id, p.supplier_id, s.name AS supplier_name, p.invoice_number,
                p.status::text AS status, p.total, p.paid, p.created_at, p.received_at,
                COALESCE(names.line_count, 0) AS line_count,
                COALESCE(names.product_names, '') AS product_names
         FROM purchase p
         JOIN supplier s ON s.id = p.supplier_id
         LEFT JOIN LATERAL (
             SELECT COUNT(*) AS line_count, string_agg(prod.name, ', ' ORDER BY l.id) AS product_names
             FROM purchase_line l JOIN product prod ON prod.id = l.product_id
             WHERE l.purchase_id = p.id
         ) names ON true
         WHERE p.id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await?)
}

async fn fetch_lines(pool: &PgPool, purchase_id: i64) -> Result<Vec<PurchaseLine>, DbError> {
    Ok(sqlx::query_as(
        "SELECT l.id, l.product_id, p.name AS product_name, l.unit_id, u.code AS unit_code,
                l.quantity, l.unit_cost, l.line_total
         FROM purchase_line l
         JOIN product p ON p.id = l.product_id
         JOIN unit u ON u.id = l.unit_id
         WHERE l.purchase_id = $1
         ORDER BY l.id",
    )
    .bind(purchase_id)
    .fetch_all(pool)
    .await?)
}

async fn fetch_payments(pool: &PgPool, purchase_id: i64) -> Result<Vec<PurchasePaymentRow>, DbError> {
    Ok(sqlx::query_as(
        "SELECT id, amount, method, paid_at
         FROM purchase_payment
         WHERE purchase_id = $1
         ORDER BY paid_at",
    )
    .bind(purchase_id)
    .fetch_all(pool)
    .await?)
}

#[tauri::command]
pub async fn list_purchases(state: tauri::State<'_, AppDb>) -> Result<Vec<Purchase>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(sqlx::query_as(
        "SELECT p.id, p.supplier_id, s.name AS supplier_name, p.invoice_number,
                p.status::text AS status, p.total, p.paid, p.created_at, p.received_at,
                COALESCE(names.line_count, 0) AS line_count,
                COALESCE(names.product_names, '') AS product_names
         FROM purchase p
         JOIN supplier s ON s.id = p.supplier_id
         LEFT JOIN LATERAL (
             SELECT COUNT(*) AS line_count, string_agg(prod.name, ', ' ORDER BY l.id) AS product_names
             FROM purchase_line l JOIN product prod ON prod.id = l.product_id
             WHERE l.purchase_id = p.id
         ) names ON true
         ORDER BY p.created_at DESC LIMIT 200",
    )
    .fetch_all(&db.pool)
    .await?)
}

#[tauri::command]
pub async fn get_purchase(
    state: tauri::State<'_, AppDb>,
    id: i64,
) -> Result<PurchaseDetail, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(PurchaseDetail {
        purchase: fetch_purchase(&db.pool, id).await?,
        lines: fetch_lines(&db.pool, id).await?,
        payments: fetch_payments(&db.pool, id).await?,
    })
}

/// Creates the purchase as a draft — no stock movement yet. Stock only moves on
/// `receive_purchase`, so a purchase can be entered ahead of the goods arriving.
#[tauri::command]
pub async fn create_purchase(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    input: PurchaseInput,
) -> Result<PurchaseDetail, DbError> {
    require_signed_in(&session).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    if input.lines.is_empty() {
        return Err(DbError::Conflict("a purchase needs at least one line".into()));
    }

    let mut tx = db.pool.begin().await?;

    let total: Decimal = input.lines.iter().map(|l| l.quantity * l.unit_cost).sum();

    let purchase_id: i64 = sqlx::query_scalar(
        "INSERT INTO purchase (supplier_id, location_id, invoice_number, status, total)
         VALUES ($1, $2, $3, 'draft', $4) RETURNING id",
    )
    .bind(input.supplier_id)
    .bind(default_location())
    .bind(input.invoice_number)
    .bind(total)
    .fetch_one(&mut *tx)
    .await?;

    for line in &input.lines {
        let line_total = line.quantity * line.unit_cost;
        sqlx::query(
            "INSERT INTO purchase_line (purchase_id, product_id, unit_id, quantity, unit_cost, line_total)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(purchase_id)
        .bind(line.product_id)
        .bind(line.unit_id)
        .bind(line.quantity)
        .bind(line.unit_cost)
        .bind(line_total)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(PurchaseDetail {
        purchase: fetch_purchase(&db.pool, purchase_id).await?,
        lines: fetch_lines(&db.pool, purchase_id).await?,
        payments: fetch_payments(&db.pool, purchase_id).await?,
    })
}

/// Marks the purchase received and writes one stock_movement per line, converted
/// to each product's base unit. All-or-nothing: a bad conversion factor on line 3
/// must not leave lines 1-2 already applied to stock.
#[tauri::command]
pub async fn receive_purchase(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    id: i64,
) -> Result<PurchaseDetail, DbError> {
    require_signed_in(&session).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let mut tx = db.pool.begin().await?;

    let status: String = sqlx::query_scalar("SELECT status::text FROM purchase WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if status != "draft" {
        return Err(DbError::Conflict(format!(
            "purchase is '{status}', not 'draft' — it cannot be received again"
        )));
    }

    let lines = fetch_lines(&db.pool, id).await?;
    for line in &lines {
        // A line's unit may not be the product's base unit (e.g. bought by the
        // box, stocked by the piece); convert through product_unit's factor.
        let base_unit_id: i64 = sqlx::query_scalar("SELECT base_unit_id FROM product WHERE id = $1")
            .bind(line.product_id)
            .fetch_one(&mut *tx)
            .await?;

        let base_qty = if line.unit_id == base_unit_id {
            line.quantity
        } else {
            let factor: Decimal = sqlx::query_scalar(
                "SELECT factor FROM product_unit WHERE product_id = $1 AND unit_id = $2",
            )
            .bind(line.product_id)
            .bind(line.unit_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                DbError::Conflict(format!(
                    "product {} has no conversion factor for unit {}",
                    line.product_id, line.unit_id
                ))
            })?;
            line.quantity * factor
        };

        sqlx::query(
            "INSERT INTO stock_movement (product_id, location_id, quantity, reason, unit_cost, ref_table, ref_id)
             VALUES ($1, $2, $3, 'purchase', $4, 'purchase', $5)",
        )
        .bind(line.product_id)
        .bind(default_location())
        .bind(base_qty)
        .bind(line.unit_cost)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query("UPDATE purchase SET status = 'received', received_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(PurchaseDetail {
        purchase: fetch_purchase(&db.pool, id).await?,
        lines: fetch_lines(&db.pool, id).await?,
        payments: fetch_payments(&db.pool, id).await?,
    })
}

#[tauri::command]
pub async fn record_purchase_payment(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    purchase_id: i64,
    amount: Decimal,
    method: String,
) -> Result<(), DbError> {
    require_signed_in(&session).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let mut tx = db.pool.begin().await?;
    sqlx::query("INSERT INTO purchase_payment (purchase_id, amount, method) VALUES ($1, $2, $3)")
        .bind(purchase_id)
        .bind(amount)
        .bind(&method)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE purchase SET paid = paid + $1 WHERE id = $2")
        .bind(amount)
        .bind(purchase_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Returns specific lines from a received purchase: reverses the stock (a
/// negative `purchase_return` movement) and reduces what is owed to the
/// supplier, atomically.
#[tauri::command]
pub async fn return_purchase_lines(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    purchase_id: i64,
    lines: Vec<ReturnLineInput>,
    reason: Option<String>,
) -> Result<(), DbError> {
    require_signed_in(&session).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    if lines.is_empty() {
        return Err(DbError::Conflict("a return needs at least one line".into()));
    }

    let mut tx = db.pool.begin().await?;

    let return_id: i64 = sqlx::query_scalar(
        "INSERT INTO purchase_return (purchase_id, status, reason) VALUES ($1, 'completed', $2) RETURNING id",
    )
    .bind(purchase_id)
    .bind(reason)
    .fetch_one(&mut *tx)
    .await?;

    let mut total = Decimal::ZERO;
    for ReturnLineInput { purchase_line_id: line_id, quantity: qty } in lines {
        let (product_id, unit_cost, unit_id): (i64, Decimal, i64) = sqlx::query_as(
            "SELECT product_id, unit_cost, unit_id FROM purchase_line WHERE id = $1 AND purchase_id = $2",
        )
        .bind(line_id)
        .bind(purchase_id)
        .fetch_one(&mut *tx)
        .await?;

        let base_unit_id: i64 = sqlx::query_scalar("SELECT base_unit_id FROM product WHERE id = $1")
            .bind(product_id)
            .fetch_one(&mut *tx)
            .await?;
        let base_qty = if unit_id == base_unit_id {
            qty
        } else {
            let factor: Decimal = sqlx::query_scalar(
                "SELECT factor FROM product_unit WHERE product_id = $1 AND unit_id = $2",
            )
            .bind(product_id)
            .bind(unit_id)
            .fetch_one(&mut *tx)
            .await?;
            qty * factor
        };

        let line_total = qty * unit_cost;
        total += line_total;

        sqlx::query(
            "INSERT INTO purchase_return_line (purchase_return_id, purchase_line_id, quantity, line_total)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(return_id)
        .bind(line_id)
        .bind(qty)
        .bind(line_total)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO stock_movement (product_id, location_id, quantity, reason, unit_cost, ref_table, ref_id)
             VALUES ($1, $2, $3, 'purchase_return', $4, 'purchase_return', $5)",
        )
        .bind(product_id)
        .bind(default_location())
        .bind(-base_qty)
        .bind(unit_cost)
        .bind(return_id)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query("UPDATE purchase_return SET total = $1 WHERE id = $2")
        .bind(total)
        .bind(return_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}
