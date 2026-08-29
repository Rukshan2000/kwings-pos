//! Sales returns: give back stock and money for lines on a completed sale.
//! Unlike `pos::complete_sale`, a return is created already `completed` in one
//! step — there is no held/draft return concept, since a cashier processes a
//! return start-to-finish at the counter.
//!
//! Refund per unit is `sale_line.line_total / sale_line.quantity` — the average
//! price actually paid after any discount — not `unit_price`, so a returned
//! item never refunds more than it was sold for.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};

use crate::db::{AppDb, DbError};

fn default_location() -> i64 {
    1
}

#[derive(Serialize, FromRow)]
pub struct ReturnableLine {
    pub sale_line_id: i64,
    pub product_id: i64,
    pub product_name: String,
    pub unit_id: i64,
    pub unit_code: String,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    pub line_total: Decimal,
    pub already_returned: Decimal,
}

#[derive(Serialize, FromRow)]
struct SaleHeaderRow {
    id: i64,
    invoice_number: Option<String>,
    status: String,
    customer_name: Option<String>,
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Serialize)]
pub struct SaleForReturn {
    pub sale_id: i64,
    pub invoice_number: Option<String>,
    pub customer_name: Option<String>,
    pub completed_at: Option<chrono::DateTime<chrono::Utc>>,
    pub lines: Vec<ReturnableLine>,
}

#[tauri::command]
pub async fn find_sale_for_return(
    state: tauri::State<'_, AppDb>,
    invoice_number: String,
) -> Result<SaleForReturn, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let header = sqlx::query_as::<_, SaleHeaderRow>(
        "SELECT s.id, s.invoice_number, s.status::text AS status, c.name AS customer_name, s.completed_at
         FROM sale s LEFT JOIN customer c ON c.id = s.customer_id
         WHERE s.invoice_number = $1",
    )
    .bind(invoice_number.trim())
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| DbError::Conflict(format!("no sale found for invoice '{invoice_number}'")))?;

    if header.status != "completed" {
        return Err(DbError::Conflict(format!(
            "sale is '{}', not 'completed' — it cannot be returned against",
            header.status
        )));
    }

    let lines = sqlx::query_as::<_, ReturnableLine>(
        "SELECT sl.id AS sale_line_id, sl.product_id, p.name AS product_name,
                sl.unit_id, u.code AS unit_code, sl.quantity, sl.unit_price, sl.line_total,
                COALESCE((
                    SELECT SUM(srl.quantity) FROM sale_return_line srl
                    JOIN sale_return sr ON sr.id = srl.sale_return_id
                    WHERE srl.sale_line_id = sl.id AND sr.status = 'completed'
                ), 0) AS already_returned
         FROM sale_line sl
         JOIN product p ON p.id = sl.product_id
         JOIN unit u ON u.id = sl.unit_id
         WHERE sl.sale_id = $1
         ORDER BY sl.id",
    )
    .bind(header.id)
    .fetch_all(&db.pool)
    .await?;

    Ok(SaleForReturn {
        sale_id: header.id,
        invoice_number: header.invoice_number,
        customer_name: header.customer_name,
        completed_at: header.completed_at,
        lines,
    })
}

#[derive(Deserialize)]
pub struct ReturnLineInput {
    pub sale_line_id: i64,
    pub quantity: Decimal,
}

#[derive(Deserialize)]
pub struct CreateReturnInput {
    pub sale_id: i64,
    pub lines: Vec<ReturnLineInput>,
    pub reason: Option<String>,
    pub refund_method: String,
}

#[derive(Serialize)]
pub struct ReturnSummary {
    pub id: i64,
    pub total: Decimal,
}

async fn to_base_qty(
    tx: &mut Transaction<'_, Postgres>,
    product_id: i64,
    unit_id: i64,
    qty: Decimal,
) -> Result<Decimal, DbError> {
    let base_unit_id: i64 = sqlx::query_scalar("SELECT base_unit_id FROM product WHERE id = $1")
        .bind(product_id)
        .fetch_one(&mut **tx)
        .await?;
    if unit_id == base_unit_id {
        return Ok(qty);
    }
    let factor: Decimal =
        sqlx::query_scalar("SELECT factor FROM product_unit WHERE product_id = $1 AND unit_id = $2")
            .bind(product_id)
            .bind(unit_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| {
                DbError::Conflict(format!(
                    "product {product_id} has no conversion factor for unit {unit_id}"
                ))
            })?;
    Ok(qty * factor)
}

#[tauri::command]
pub async fn create_return(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, crate::auth::SessionState>,
    input: CreateReturnInput,
) -> Result<ReturnSummary, DbError> {
    if session.0.read().await.as_ref().is_none() {
        return Err(DbError::Conflict("please sign in first".into()));
    }

    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    if input.lines.is_empty() {
        return Err(DbError::Conflict("a return needs at least one line".into()));
    }

    let mut tx = db.pool.begin().await?;

    let status: String = sqlx::query_scalar("SELECT status::text FROM sale WHERE id = $1")
        .bind(input.sale_id)
        .fetch_one(&mut *tx)
        .await?;
    if status != "completed" {
        return Err(DbError::Conflict(format!(
            "sale is '{status}', not 'completed' — it cannot be returned against"
        )));
    }

    let created_by = session.0.read().await.as_ref().map(|u| u.id);
    let mut total = Decimal::ZERO;
    let mut resolved_lines = Vec::with_capacity(input.lines.len());

    for line in &input.lines {
        if line.quantity <= Decimal::ZERO {
            return Err(DbError::Conflict("return quantity must be greater than zero".into()));
        }

        let (product_id, unit_id, sold_qty, unit_cost, line_total): (i64, i64, Decimal, Decimal, Decimal) =
            sqlx::query_as(
                "SELECT product_id, unit_id, quantity, unit_cost, line_total
                 FROM sale_line WHERE id = $1 AND sale_id = $2",
            )
            .bind(line.sale_line_id)
            .bind(input.sale_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| DbError::Conflict("that line does not belong to this sale".into()))?;

        let already_returned: Decimal = sqlx::query_scalar(
            "SELECT COALESCE(SUM(srl.quantity), 0) FROM sale_return_line srl
             JOIN sale_return sr ON sr.id = srl.sale_return_id
             WHERE srl.sale_line_id = $1 AND sr.status = 'completed'",
        )
        .bind(line.sale_line_id)
        .fetch_one(&mut *tx)
        .await?;

        let returnable = sold_qty - already_returned;
        if line.quantity > returnable {
            return Err(DbError::Conflict(format!(
                "only {returnable} of that item can still be returned"
            )));
        }

        let refund = (line_total / sold_qty) * line.quantity;
        total += refund;
        resolved_lines.push((line.sale_line_id, product_id, unit_id, line.quantity, unit_cost, refund));
    }

    let return_id: i64 = sqlx::query_scalar(
        "INSERT INTO sale_return (sale_id, status, reason, refund_method, total, created_by)
         VALUES ($1, 'completed', $2, $3::payment_method, $4, $5) RETURNING id",
    )
    .bind(input.sale_id)
    .bind(&input.reason)
    .bind(&input.refund_method)
    .bind(total)
    .bind(created_by)
    .fetch_one(&mut *tx)
    .await?;

    for (sale_line_id, product_id, unit_id, quantity, unit_cost, refund) in resolved_lines {
        sqlx::query(
            "INSERT INTO sale_return_line (sale_return_id, sale_line_id, quantity, line_total)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(return_id)
        .bind(sale_line_id)
        .bind(quantity)
        .bind(refund)
        .execute(&mut *tx)
        .await?;

        let base_qty = to_base_qty(&mut tx, product_id, unit_id, quantity).await?;
        sqlx::query(
            "INSERT INTO stock_movement (product_id, location_id, quantity, reason, unit_cost, ref_table, ref_id, created_by)
             VALUES ($1, $2, $3, 'sale_return', $4, 'sale_return', $5, $6)",
        )
        .bind(product_id)
        .bind(default_location())
        .bind(base_qty)
        .bind(unit_cost)
        .bind(return_id)
        .bind(created_by)
        .execute(&mut *tx)
        .await?;
    }

    // A refund pays down what the customer still owed before it hands back
    // cash — it cannot make balance_due negative.
    sqlx::query("UPDATE sale SET balance_due = GREATEST(balance_due - $1, 0) WHERE id = $2")
        .bind(total)
        .bind(input.sale_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(ReturnSummary { id: return_id, total })
}
