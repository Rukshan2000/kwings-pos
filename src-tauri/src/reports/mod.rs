//! Read-only reporting over completed sales, purchases, and stock — no writes,
//! no new tables. Every report takes a `[from, to]` date range (inclusive,
//! matched against the row's local calendar date) so the frontend can drive all
//! of them with one date-range picker.

use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::FromRow;

use crate::auth::SessionState;
use crate::db::{AppDb, DbError};

fn default_location() -> i64 {
    1
}

/// Manager/admin only — the same gate as `sales_by_cashier`, applied to every
/// other report that exposes revenue, cost, or margin data across the whole shop.
async fn require_manager(session: &tauri::State<'_, SessionState>) -> Result<(), DbError> {
    match session.0.read().await.as_ref() {
        Some(u) if u.role == "admin" || u.role == "manager" => Ok(()),
        Some(_) => Err(DbError::Conflict("you don't have permission to do this".into())),
        None => Err(DbError::Conflict("please sign in first".into())),
    }
}

#[derive(Serialize, FromRow)]
pub struct RevenueDay {
    pub day: chrono::NaiveDate,
    pub order_count: i64,
    pub revenue: Decimal,
}

#[derive(Serialize, FromRow)]
struct RevenueTotals {
    order_count: i64,
    subtotal: Decimal,
    discount_total: Decimal,
    tax_total: Decimal,
    revenue: Decimal,
}

#[derive(Serialize)]
pub struct RevenueReport {
    pub order_count: i64,
    pub subtotal: Decimal,
    pub discount_total: Decimal,
    pub tax_total: Decimal,
    pub revenue: Decimal,
    pub daily: Vec<RevenueDay>,
}

#[tauri::command]
pub async fn revenue_report(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
) -> Result<RevenueReport, DbError> {
    require_manager(&session).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let totals = sqlx::query_as::<_, RevenueTotals>(
        "SELECT COUNT(*) AS order_count,
                COALESCE(SUM(subtotal), 0) AS subtotal,
                COALESCE(SUM(discount_total), 0) AS discount_total,
                COALESCE(SUM(tax_total), 0) AS tax_total,
                COALESCE(SUM(grand_total), 0) AS revenue
         FROM sale
         WHERE status = 'completed' AND (completed_at AT TIME ZONE 'UTC')::date BETWEEN $1 AND $2",
    )
    .bind(from)
    .bind(to)
    .fetch_one(&db.pool)
    .await?;

    let daily = sqlx::query_as::<_, RevenueDay>(
        "SELECT (completed_at AT TIME ZONE 'UTC')::date AS day,
                COUNT(*) AS order_count,
                COALESCE(SUM(grand_total), 0) AS revenue
         FROM sale
         WHERE status = 'completed' AND (completed_at AT TIME ZONE 'UTC')::date BETWEEN $1 AND $2
         GROUP BY day
         ORDER BY day",
    )
    .bind(from)
    .bind(to)
    .fetch_all(&db.pool)
    .await?;

    Ok(RevenueReport {
        order_count: totals.order_count,
        subtotal: totals.subtotal,
        discount_total: totals.discount_total,
        tax_total: totals.tax_total,
        revenue: totals.revenue,
        daily,
    })
}

#[derive(Serialize, FromRow)]
pub struct ProductSalesRow {
    pub product_id: i64,
    pub product_name: String,
    pub sku: Option<String>,
    pub quantity: Decimal,
    pub revenue: Decimal,
    pub cost: Decimal,
    pub profit: Decimal,
}

#[tauri::command]
pub async fn sales_by_product(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
) -> Result<Vec<ProductSalesRow>, DbError> {
    require_manager(&session).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    Ok(sqlx::query_as::<_, ProductSalesRow>(
        "SELECT p.id AS product_id, p.name AS product_name, p.sku,
                SUM(sl.quantity) AS quantity,
                SUM(sl.line_total) AS revenue,
                SUM(sl.quantity * sl.unit_cost) AS cost,
                SUM(sl.line_total - sl.quantity * sl.unit_cost) AS profit
         FROM sale_line sl
         JOIN sale s ON s.id = sl.sale_id
         JOIN product p ON p.id = sl.product_id
         WHERE s.status = 'completed'
           AND (s.completed_at AT TIME ZONE 'UTC')::date BETWEEN $1 AND $2
         GROUP BY p.id, p.name, p.sku
         ORDER BY revenue DESC",
    )
    .bind(from)
    .bind(to)
    .fetch_all(&db.pool)
    .await?)
}

#[derive(Serialize, FromRow)]
pub struct CategoryProfitRow {
    pub category_name: String,
    pub revenue: Decimal,
    pub cost: Decimal,
    pub profit: Decimal,
}

#[derive(Serialize, FromRow)]
struct ProfitTotals {
    revenue: Decimal,
    cost: Decimal,
    discount_total: Decimal,
    profit: Decimal,
}

#[derive(Serialize)]
pub struct ProfitReport {
    pub revenue: Decimal,
    pub cost: Decimal,
    pub discount_total: Decimal,
    pub profit: Decimal,
    pub margin_pct: Decimal,
    pub by_category: Vec<CategoryProfitRow>,
}

#[tauri::command]
pub async fn profit_summary(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
) -> Result<ProfitReport, DbError> {
    require_manager(&session).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let totals = sqlx::query_as::<_, ProfitTotals>(
        "SELECT COALESCE(SUM(sl.line_total), 0) AS revenue,
                COALESCE(SUM(sl.quantity * sl.unit_cost), 0) AS cost,
                COALESCE((SELECT SUM(s2.discount_total) FROM sale s2
                          WHERE s2.status = 'completed'
                            AND (s2.completed_at AT TIME ZONE 'UTC')::date BETWEEN $1 AND $2), 0) AS discount_total,
                COALESCE(SUM(sl.line_total - sl.quantity * sl.unit_cost), 0) AS profit
         FROM sale_line sl
         JOIN sale s ON s.id = sl.sale_id
         WHERE s.status = 'completed'
           AND (s.completed_at AT TIME ZONE 'UTC')::date BETWEEN $1 AND $2",
    )
    .bind(from)
    .bind(to)
    .fetch_one(&db.pool)
    .await?;

    let by_category = sqlx::query_as::<_, CategoryProfitRow>(
        "SELECT COALESCE(c.name, 'Uncategorised') AS category_name,
                SUM(sl.line_total) AS revenue,
                SUM(sl.quantity * sl.unit_cost) AS cost,
                SUM(sl.line_total - sl.quantity * sl.unit_cost) AS profit
         FROM sale_line sl
         JOIN sale s ON s.id = sl.sale_id
         JOIN product p ON p.id = sl.product_id
         LEFT JOIN category c ON c.id = p.category_id
         WHERE s.status = 'completed'
           AND (s.completed_at AT TIME ZONE 'UTC')::date BETWEEN $1 AND $2
         GROUP BY category_name
         ORDER BY revenue DESC",
    )
    .bind(from)
    .bind(to)
    .fetch_all(&db.pool)
    .await?;

    let margin_pct = if totals.revenue.is_zero() {
        Decimal::ZERO
    } else {
        (totals.profit / totals.revenue) * Decimal::ONE_HUNDRED
    };

    Ok(ProfitReport {
        revenue: totals.revenue,
        cost: totals.cost,
        discount_total: totals.discount_total,
        profit: totals.profit,
        margin_pct,
        by_category,
    })
}

#[derive(Serialize, FromRow)]
pub struct PaymentMethodRow {
    pub method: String,
    pub order_count: i64,
    pub total: Decimal,
}

#[tauri::command]
pub async fn payment_breakdown(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
) -> Result<Vec<PaymentMethodRow>, DbError> {
    require_manager(&session).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    Ok(sqlx::query_as::<_, PaymentMethodRow>(
        "SELECT sp.method::text AS method,
                COUNT(*) AS order_count,
                COALESCE(SUM(sp.amount), 0) AS total
         FROM sale_payment sp
         JOIN sale s ON s.id = sp.sale_id
         WHERE s.status = 'completed'
           AND (s.completed_at AT TIME ZONE 'UTC')::date BETWEEN $1 AND $2
         GROUP BY sp.method
         ORDER BY total DESC",
    )
    .bind(from)
    .bind(to)
    .fetch_all(&db.pool)
    .await?)
}

#[derive(Serialize, FromRow)]
pub struct SupplierPurchaseRow {
    pub supplier_id: i64,
    pub supplier_name: String,
    pub purchase_count: i64,
    pub total: Decimal,
    pub paid: Decimal,
    pub outstanding: Decimal,
}

#[derive(Serialize, FromRow)]
struct PurchaseTotals {
    purchase_count: i64,
    total: Decimal,
    paid: Decimal,
    outstanding: Decimal,
}

#[derive(Serialize)]
pub struct PurchasesReport {
    pub purchase_count: i64,
    pub total: Decimal,
    pub paid: Decimal,
    pub outstanding: Decimal,
    pub by_supplier: Vec<SupplierPurchaseRow>,
}

#[tauri::command]
pub async fn purchases_report(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
) -> Result<PurchasesReport, DbError> {
    require_manager(&session).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    // Received/outstanding purchases only — a draft purchase hasn't happened yet.
    let totals = sqlx::query_as::<_, PurchaseTotals>(
        "SELECT COUNT(*) AS purchase_count,
                COALESCE(SUM(total), 0) AS total,
                COALESCE(SUM(paid), 0) AS paid,
                COALESCE(SUM(total - paid), 0) AS outstanding
         FROM purchase
         WHERE status = 'received' AND COALESCE(received_at, created_at)::date BETWEEN $1 AND $2",
    )
    .bind(from)
    .bind(to)
    .fetch_one(&db.pool)
    .await?;

    let by_supplier = sqlx::query_as::<_, SupplierPurchaseRow>(
        "SELECT sup.id AS supplier_id, sup.name AS supplier_name,
                COUNT(*) AS purchase_count,
                COALESCE(SUM(pu.total), 0) AS total,
                COALESCE(SUM(pu.paid), 0) AS paid,
                COALESCE(SUM(pu.total - pu.paid), 0) AS outstanding
         FROM purchase pu
         JOIN supplier sup ON sup.id = pu.supplier_id
         WHERE pu.status = 'received' AND COALESCE(pu.received_at, pu.created_at)::date BETWEEN $1 AND $2
         GROUP BY sup.id, sup.name
         ORDER BY total DESC",
    )
    .bind(from)
    .bind(to)
    .fetch_all(&db.pool)
    .await?;

    Ok(PurchasesReport {
        purchase_count: totals.purchase_count,
        total: totals.total,
        paid: totals.paid,
        outstanding: totals.outstanding,
        by_supplier,
    })
}

#[derive(Serialize, FromRow)]
pub struct CashierSalesRow {
    pub cashier_id: Option<i64>,
    pub cashier_name: String,
    pub order_count: i64,
    pub revenue: Decimal,
}

/// Manager/admin view across every cashier. Sales completed before cashier
/// attribution existed (or by a since-removed account) show as "Unassigned"
/// rather than being silently dropped from the total.
#[tauri::command]
pub async fn sales_by_cashier(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
) -> Result<Vec<CashierSalesRow>, DbError> {
    require_manager(&session).await?;

    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    Ok(sqlx::query_as::<_, CashierSalesRow>(
        "SELECT u.id AS cashier_id, COALESCE(u.display_name, 'Unassigned') AS cashier_name,
                COUNT(*) AS order_count,
                COALESCE(SUM(s.grand_total), 0) AS revenue
         FROM sale s
         LEFT JOIN app_user u ON u.id = s.created_by
         WHERE s.status = 'completed'
           AND (s.completed_at AT TIME ZONE 'UTC')::date BETWEEN $1 AND $2
         GROUP BY u.id, u.display_name
         ORDER BY revenue DESC",
    )
    .bind(from)
    .bind(to)
    .fetch_all(&db.pool)
    .await?)
}

/// Any signed-in user's own totals — a cashier's till-side view of their own
/// performance, no role check needed since it can only ever show their own rows.
#[tauri::command]
pub async fn my_sales(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
) -> Result<CashierSalesRow, DbError> {
    let current = session
        .0
        .read()
        .await
        .clone()
        .ok_or_else(|| DbError::Conflict("please sign in first".into()))?;

    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let row = sqlx::query_as::<_, (i64, Decimal)>(
        "SELECT COUNT(*), COALESCE(SUM(grand_total), 0)
         FROM sale
         WHERE status = 'completed' AND created_by = $1
           AND (completed_at AT TIME ZONE 'UTC')::date BETWEEN $2 AND $3",
    )
    .bind(current.id)
    .bind(from)
    .bind(to)
    .fetch_one(&db.pool)
    .await?;

    Ok(CashierSalesRow {
        cashier_id: Some(current.id),
        cashier_name: current.display_name,
        order_count: row.0,
        revenue: row.1,
    })
}

#[derive(Serialize, FromRow)]
pub struct StockSummary {
    pub product_count: i64,
    pub low_stock_count: i64,
    pub total_on_hand_value: Decimal,
}

#[tauri::command]
pub async fn stock_summary(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
) -> Result<StockSummary, DbError> {
    require_manager(&session).await?;
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    Ok(sqlx::query_as::<_, StockSummary>(
        "SELECT COUNT(*) AS product_count,
                COUNT(*) FILTER (
                    WHERE p.low_stock_at > 0 AND on_hand.qty <= p.low_stock_at
                ) AS low_stock_count,
                COALESCE(SUM(on_hand.qty * p.cost_price), 0) AS total_on_hand_value
         FROM product p
         LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(m.quantity), 0) AS qty
             FROM stock_movement m
             WHERE m.product_id = p.id AND m.location_id = $1
         ) on_hand ON true
         WHERE p.archived_at IS NULL",
    )
    .bind(default_location())
    .fetch_one(&db.pool)
    .await?)
}
