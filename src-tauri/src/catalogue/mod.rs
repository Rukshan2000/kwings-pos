//! Products, categories, brands, units, and price tiers — phase 3.
//!
//! All business logic and SQL live here, never in the frontend. Reads use plain
//! runtime-checked queries (`query_as`) rather than the `query!` compile-time
//! macros: those need a live database or a committed `.sqlx` offline cache at
//! build time, which this project does not have yet (see PLAN.md).

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::db::{duplicate, require_name, AppDb, DbError};

#[derive(Serialize, FromRow)]
pub struct Category {
    pub id: i64,
    pub name: String,
}

#[derive(Serialize, FromRow)]
pub struct Brand {
    pub id: i64,
    pub name: String,
}

#[derive(Serialize, FromRow)]
pub struct Unit {
    pub id: i64,
    pub code: String,
    pub name: String,
}

#[derive(Serialize, FromRow)]
pub struct ProductUnit {
    pub id: i64,
    pub unit_id: i64,
    pub unit_code: String,
    pub factor: Decimal,
    pub barcode: Option<String>,
}

#[derive(Serialize, FromRow)]
pub struct PriceTier {
    pub id: i64,
    pub unit_id: i64,
    pub unit_code: String,
    pub kind: String,
    pub min_qty: Decimal,
    pub price: Decimal,
}

#[derive(Serialize, FromRow)]
pub struct Product {
    pub id: i64,
    pub sku: Option<String>,
    pub barcode: Option<String>,
    pub name: String,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub brand_id: Option<i64>,
    pub brand_name: Option<String>,
    pub base_unit_id: i64,
    pub base_unit_code: String,
    pub cost_price: Decimal,
    pub selling_price: Decimal,
    /// Stock at or below this warns on the inventory screen. 0 means "never
    /// warn" — the shop saying so, rather than the field having been skipped.
    pub low_stock_at: Decimal,
    pub active: bool,
    /// Offered as a one-tap button on the till, beside Hold — shopping bags and
    /// anything else sold alongside almost every order.
    pub quick_add: bool,
    /// Orders the quick-add buttons; ties fall back to name.
    pub sort_order: i32,
}

#[derive(Serialize)]
pub struct ProductDetail {
    #[serde(flatten)]
    pub product: Product,
    pub units: Vec<ProductUnit>,
    pub price_tiers: Vec<PriceTier>,
}

#[derive(Deserialize)]
pub struct ProductInput {
    pub sku: Option<String>,
    pub barcode: Option<String>,
    pub name: String,
    pub category_id: Option<i64>,
    pub brand_id: Option<i64>,
    pub base_unit_id: i64,
    pub cost_price: Decimal,
    pub selling_price: Decimal,
    pub low_stock_at: Decimal,
    #[serde(default)]
    pub quick_add: bool,
    #[serde(default)]
    pub sort_order: i32,
}

#[derive(Deserialize)]
pub struct ProductUnitInput {
    pub unit_id: i64,
    pub factor: Decimal,
    pub barcode: Option<String>,
}

#[derive(Deserialize)]
pub struct PriceTierInput {
    pub unit_id: i64,
    pub kind: String,
    pub min_qty: Decimal,
    pub price: Decimal,
}

const PRODUCT_SELECT: &str = "
    SELECT p.id, p.sku, p.barcode, p.name,
           p.category_id, c.name AS category_name,
           p.brand_id, b.name AS brand_name,
           p.base_unit_id, u.code AS base_unit_code,
           p.cost_price, p.selling_price, p.low_stock_at, p.active,
           p.quick_add, p.sort_order
    FROM product p
    LEFT JOIN category c ON c.id = p.category_id
    LEFT JOIN brand b ON b.id = p.brand_id
    JOIN unit u ON u.id = p.base_unit_id
";

async fn fetch_product(pool: &PgPool, id: i64) -> Result<Product, DbError> {
    Ok(
        sqlx::query_as::<_, Product>(&format!("{PRODUCT_SELECT} WHERE p.id = $1"))
            .bind(id)
            .fetch_one(pool)
            .await?,
    )
}

async fn fetch_units(pool: &PgPool, product_id: i64) -> Result<Vec<ProductUnit>, DbError> {
    Ok(sqlx::query_as::<_, ProductUnit>(
        "SELECT pu.id, pu.unit_id, u.code AS unit_code, pu.factor, pu.barcode
         FROM product_unit pu JOIN unit u ON u.id = pu.unit_id
         WHERE pu.product_id = $1 ORDER BY u.code",
    )
    .bind(product_id)
    .fetch_all(pool)
    .await?)
}

async fn fetch_price_tiers(pool: &PgPool, product_id: i64) -> Result<Vec<PriceTier>, DbError> {
    Ok(sqlx::query_as::<_, PriceTier>(
        "SELECT t.id, t.unit_id, u.code AS unit_code, t.kind::text AS kind, t.min_qty, t.price
         FROM product_price_tier t JOIN unit u ON u.id = t.unit_id
         WHERE t.product_id = $1 ORDER BY t.kind, t.min_qty",
    )
    .bind(product_id)
    .fetch_all(pool)
    .await?)
}

#[tauri::command]
pub async fn list_categories(state: tauri::State<'_, AppDb>) -> Result<Vec<Category>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(
        sqlx::query_as("SELECT id, name FROM category WHERE archived_at IS NULL ORDER BY name")
            .fetch_all(&db.pool)
            .await?,
    )
}

#[tauri::command]
pub async fn create_category(
    state: tauri::State<'_, AppDb>,
    name: String,
) -> Result<Category, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    let name = require_name(&name, "category")?;
    sqlx::query_as("INSERT INTO category (name) VALUES ($1) RETURNING id, name")
        .bind(&name)
        .fetch_one(&db.pool)
        .await
        .map_err(|e| duplicate(e, "category", &name))
}

#[tauri::command]
pub async fn list_brands(state: tauri::State<'_, AppDb>) -> Result<Vec<Brand>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(
        sqlx::query_as("SELECT id, name FROM brand WHERE archived_at IS NULL ORDER BY name")
            .fetch_all(&db.pool)
            .await?,
    )
}

#[tauri::command]
pub async fn create_brand(
    state: tauri::State<'_, AppDb>,
    name: String,
) -> Result<Brand, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    let name = require_name(&name, "brand")?;
    sqlx::query_as("INSERT INTO brand (name) VALUES ($1) RETURNING id, name")
        .bind(&name)
        .fetch_one(&db.pool)
        .await
        .map_err(|e| duplicate(e, "brand", &name))
}

#[tauri::command]
pub async fn list_units(state: tauri::State<'_, AppDb>) -> Result<Vec<Unit>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(
        sqlx::query_as("SELECT id, code, name FROM unit WHERE archived_at IS NULL ORDER BY name")
            .fetch_all(&db.pool)
            .await?,
    )
}

/// Units are shop data, not ours.
///
/// The migration seeds the ten a Sri Lankan agro shop is likely to start with,
/// but nothing in the app may assume that list is complete — a shop selling by
/// the acre, the roll or the bundle has to be able to say so. Products already
/// resolve their base unit through `unit.id`, so a unit created here is usable
/// as a base unit immediately.
#[tauri::command]
pub async fn create_unit(
    state: tauri::State<'_, AppDb>,
    code: String,
    name: String,
) -> Result<Unit, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let code = require_name(&code, "unit code")?;
    let name = require_name(&name, "unit")?;

    sqlx::query_as("INSERT INTO unit (code, name) VALUES ($1, $2) RETURNING id, code, name")
        .bind(&code)
        .bind(&name)
        .fetch_one(&db.pool)
        .await
        .map_err(|e| duplicate(e, "unit with code", &code))
}

#[tauri::command]
/// `archived = Some(true)` lists what has been archived instead of what is on
/// sale — the same rows, the other side of the same flag, so restoring does not
/// need a screen or a query of its own.
pub async fn list_products(
    state: tauri::State<'_, AppDb>,
    search: Option<String>,
    archived: Option<bool>,
) -> Result<Vec<Product>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let scope = if archived.unwrap_or(false) {
        "p.archived_at IS NOT NULL"
    } else {
        "p.archived_at IS NULL"
    };

    let rows = match search.filter(|s| !s.trim().is_empty()) {
        Some(q) => {
            sqlx::query_as::<_, Product>(&format!(
                "{PRODUCT_SELECT} WHERE {scope}
                 AND (p.name ILIKE $1 OR p.sku ILIKE $1 OR p.barcode = $2)
                 ORDER BY p.name LIMIT 200"
            ))
            .bind(format!("%{}%", q.trim()))
            .bind(q.trim())
            .fetch_all(&db.pool)
            .await?
        }
        None => {
            sqlx::query_as::<_, Product>(&format!(
                "{PRODUCT_SELECT} WHERE {scope} ORDER BY p.name LIMIT 200"
            ))
            .fetch_all(&db.pool)
            .await?
        }
    };
    Ok(rows)
}

#[tauri::command]
pub async fn get_product(
    state: tauri::State<'_, AppDb>,
    id: i64,
) -> Result<ProductDetail, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(ProductDetail {
        product: fetch_product(&db.pool, id).await?,
        units: fetch_units(&db.pool, id).await?,
        price_tiers: fetch_price_tiers(&db.pool, id).await?,
    })
}

/// A SKU/barcode collision surfaces as this specific error rather than the raw
/// Postgres unique-violation text, since the frontend needs to tell the cashier
/// which field to fix.
#[derive(Debug, thiserror::Error)]
pub enum ProductSaveError {
    #[error("that SKU is already used by another product")]
    DuplicateSku,
    #[error("that barcode is already used by another product")]
    DuplicateBarcode,
    #[error(transparent)]
    Other(#[from] DbError),
}

impl serde::Serialize for ProductSaveError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn map_unique_violation(e: sqlx::Error) -> ProductSaveError {
    if let sqlx::Error::Database(ref db_err) = e {
        if db_err.code().as_deref() == Some("23505") {
            let constraint = db_err.constraint().unwrap_or("");
            if constraint.contains("sku") {
                return ProductSaveError::DuplicateSku;
            }
            if constraint.contains("barcode") {
                return ProductSaveError::DuplicateBarcode;
            }
        }
    }
    ProductSaveError::Other(e.into())
}

#[tauri::command]
pub async fn create_product(
    state: tauri::State<'_, AppDb>,
    input: ProductInput,
) -> Result<Product, ProductSaveError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO product (sku, barcode, name, category_id, brand_id, base_unit_id,
                               cost_price, selling_price, low_stock_at, quick_add, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id",
    )
    .bind(non_empty(input.sku))
    .bind(non_empty(input.barcode))
    .bind(input.name.trim())
    .bind(input.category_id)
    .bind(input.brand_id)
    .bind(input.base_unit_id)
    .bind(input.cost_price)
    .bind(input.selling_price)
    .bind(input.low_stock_at)
    .bind(input.quick_add)
    .bind(input.sort_order)
    .fetch_one(&db.pool)
    .await
    .map_err(map_unique_violation)?;

    Ok(fetch_product(&db.pool, id).await?)
}

#[tauri::command]
pub async fn update_product(
    state: tauri::State<'_, AppDb>,
    id: i64,
    input: ProductInput,
) -> Result<Product, ProductSaveError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    sqlx::query(
        "UPDATE product SET sku = $1, barcode = $2, name = $3, category_id = $4,
                             brand_id = $5, base_unit_id = $6, cost_price = $7,
                             selling_price = $8, low_stock_at = $9,
                             quick_add = $10, sort_order = $11
         WHERE id = $12",
    )
    .bind(non_empty(input.sku))
    .bind(non_empty(input.barcode))
    .bind(input.name.trim())
    .bind(input.category_id)
    .bind(input.brand_id)
    .bind(input.base_unit_id)
    .bind(input.cost_price)
    .bind(input.selling_price)
    .bind(input.low_stock_at)
    .bind(input.quick_add)
    .bind(input.sort_order)
    .bind(id)
    .execute(&db.pool)
    .await
    .map_err(map_unique_violation)?;

    Ok(fetch_product(&db.pool, id).await?)
}

/// Soft delete only — a product may be referenced by historical sales and
/// purchases, and hard-deleting it would corrupt that history.
#[tauri::command]
pub async fn archive_product(state: tauri::State<'_, AppDb>, id: i64) -> Result<(), DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    sqlx::query("UPDATE product SET active = false, archived_at = now() WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

/// Undoes an archive. Nothing was deleted, so this is only clearing the flag
/// that hid the product — its history, stock and price tiers are untouched and
/// come back with it.
#[tauri::command]
pub async fn restore_product(state: tauri::State<'_, AppDb>, id: i64) -> Result<Product, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    sqlx::query("UPDATE product SET active = true, archived_at = NULL WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await?;
    fetch_product(&db.pool, id).await
}

#[tauri::command]
pub async fn set_product_unit(
    state: tauri::State<'_, AppDb>,
    product_id: i64,
    input: ProductUnitInput,
) -> Result<Vec<ProductUnit>, ProductSaveError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    sqlx::query(
        "INSERT INTO product_unit (product_id, unit_id, factor, barcode)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (product_id, unit_id)
         DO UPDATE SET factor = EXCLUDED.factor, barcode = EXCLUDED.barcode",
    )
    .bind(product_id)
    .bind(input.unit_id)
    .bind(input.factor)
    .bind(non_empty(input.barcode))
    .execute(&db.pool)
    .await
    .map_err(map_unique_violation)?;

    Ok(fetch_units(&db.pool, product_id).await?)
}

#[tauri::command]
pub async fn set_price_tier(
    state: tauri::State<'_, AppDb>,
    product_id: i64,
    input: PriceTierInput,
) -> Result<Vec<PriceTier>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    sqlx::query(
        "INSERT INTO product_price_tier (product_id, unit_id, kind, min_qty, price)
         VALUES ($1, $2, $3::price_tier_kind, $4, $5)
         ON CONFLICT (product_id, unit_id, kind, min_qty)
         DO UPDATE SET price = EXCLUDED.price",
    )
    .bind(product_id)
    .bind(input.unit_id)
    .bind(&input.kind)
    .bind(input.min_qty)
    .bind(input.price)
    .execute(&db.pool)
    .await?;

    Ok(fetch_price_tiers(&db.pool, product_id).await?)
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
