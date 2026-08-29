//! One-click import of shop data from the old "AgroPlus" POS (a Next.js app with
//! its own flat Postgres schema) into this app's normalized schema — for the shop
//! owner replacing the old system on the same machine, run once from Settings.
//!
//! Mirrors scripts/migrate-agroplus.mjs (the one-off Node script used for the
//! developer's own migration) but takes the old database's connection details
//! from the admin at runtime instead of a hardcoded URL, and writes into this
//! app's already-running database pool instead of a second ad-hoc connection.
//!
//! Old `sales` rows have no order header (one row per line item, nothing groups
//! them into a basket) so each becomes its own single-line `sale` here, tagged
//! `AGP-<old id>` as its invoice number. Stock is reconciled with one 'opening'
//! stock_movement per product — old restocks/sales/returns are replayed as their
//! own movements, and the remaining gap between that replay and the old
//! `stock_quantity` becomes the opening entry — so current stock matches the old
//! system exactly regardless of any gaps in its history.
//!
//! Safe to re-run: categories/users/products/sales are looked up or upserted by
//! their natural key, so a second run does not duplicate them. Customers, price
//! options, returns, and restock movements are not deduplicated (the old system
//! gives them no natural key) — re-running will duplicate those, so this should
//! be run once per shop.

use std::collections::HashMap;
use std::time::Duration;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHasher, SaltString};
use argon2::Argon2;
use chrono::{DateTime, NaiveDateTime, Utc};
use rand::Rng;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgPool, Row};

use crate::auth::{require_role, SessionState};
use crate::db::{AppDb, DbError};

#[derive(Deserialize)]
pub struct AgroPlusConnectionInput {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct ImportedCredential {
    pub username: String,
    pub display_name: String,
    pub temp_password: String,
}

#[derive(Serialize, Default)]
pub struct ImportSummary {
    pub categories: i64,
    pub users: i64,
    pub products: i64,
    pub price_options: i64,
    pub customers: i64,
    pub sales: i64,
    pub returns: i64,
    pub restock_movements: i64,
    pub opening_plugs: i64,
    /// Temp passwords for accounts created in *this* run only — shown once, never
    /// re-derivable afterwards, so the admin must copy them down now.
    pub credentials: Vec<ImportedCredential>,
}

fn random_password() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..12)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

fn hash_password(password: &str) -> Result<String, DbError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| DbError::Conflict(format!("could not hash password: {e}")))
}

/// Old `products.unit_type` -> this app's `unit.code` (seeded in 0003_seed.sql).
fn map_unit_code(unit_type: &str) -> &'static str {
    match unit_type {
        "kg" => "kg",
        "g" => "g",
        "l" => "l",
        "ml" => "ml",
        "bags" => "bag",
        "bottles" => "btl",
        "packets" => "pkt",
        _ => "pc", // "items", "pcs", and anything unrecognised
    }
}

/// Old `users.role` -> this app's `user_role` enum.
fn map_role(old_role: &str) -> &'static str {
    match old_role {
        "admin" => "admin",
        "manager" => "manager",
        _ => "cashier",
    }
}

fn map_payment_method(old: &str) -> &'static str {
    if old == "card" {
        "card"
    } else {
        "cash"
    }
}

fn as_utc(naive: NaiveDateTime) -> DateTime<Utc> {
    DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc)
}

#[tauri::command]
pub async fn import_from_agroplus(
    db: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    input: AgroPlusConnectionInput,
) -> Result<ImportSummary, DbError> {
    require_role(&session, &["admin"]).await?;

    let source_opts = PgConnectOptions::new()
        .host(&input.host)
        .port(input.port)
        .database(&input.database)
        .username(&input.username)
        .password(&input.password);

    let source: PgPool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(source_opts)
        .await
        .map_err(|e| DbError::Conflict(format!("could not connect to the old database: {e}")))?;

    let guard = db.0.read().await;
    let pool = &guard.as_ref().ok_or(DbError::NotReady)?.pool;
    let mut tx = pool.begin().await?;
    let mut summary = ImportSummary::default();

    // ---------------------------------------------------------------- location
    let location_id: i64 = sqlx::query_scalar("SELECT id FROM location WHERE is_default LIMIT 1")
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| DbError::Conflict("this app's database has no default location yet".into()))?;

    // ------------------------------------------------------------------- units
    let unit_rows = sqlx::query("SELECT id, code FROM unit").fetch_all(&mut *tx).await?;
    let unit_id_by_code: HashMap<String, i64> = unit_rows
        .iter()
        .map(|r| (r.get::<String, _>("code"), r.get::<i64, _>("id")))
        .collect();

    // -------------------------------------------------------------- categories
    let old_categories = sqlx::query("SELECT name FROM categories")
        .fetch_all(&source)
        .await
        .map_err(|e| DbError::Conflict(format!("could not read old categories: {e}")))?;
    let old_product_categories = sqlx::query(
        "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category <> ''",
    )
    .fetch_all(&source)
    .await
    .map_err(|e| DbError::Conflict(format!("could not read old product categories: {e}")))?;

    let mut category_names: Vec<String> = old_categories
        .iter()
        .map(|r| r.get::<String, _>("name"))
        .chain(old_product_categories.iter().map(|r| r.get::<String, _>("category")))
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();
    category_names.sort();
    category_names.dedup();

    let mut category_id_by_name: HashMap<String, i64> = HashMap::new();
    for name in &category_names {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO category (name) VALUES ($1)
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
             RETURNING id",
        )
        .bind(name)
        .fetch_one(&mut *tx)
        .await?;
        category_id_by_name.insert(name.clone(), id);
    }
    summary.categories = category_id_by_name.len() as i64;

    // ------------------------------------------------------------------ users
    let old_users = sqlx::query("SELECT id, email, name, role FROM users ORDER BY id")
        .fetch_all(&source)
        .await
        .map_err(|e| DbError::Conflict(format!("could not read old users: {e}")))?;

    let mut new_user_id_by_old_id: HashMap<i64, i64> = HashMap::new();
    for row in &old_users {
        let old_id: i32 = row.get("id");
        let email: String = row.get("email");
        let name: Option<String> = row.try_get("name").ok();
        let role: String = row.get("role");

        let username = email
            .split('@')
            .next()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase())
            .unwrap_or_else(|| format!("user{old_id}"));
        let display_name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| username.clone());
        let temp_password = random_password();
        let hash = hash_password(&temp_password)?;

        let (id, inserted): (i64, bool) = sqlx::query_as(
            "WITH ins AS (
                INSERT INTO app_user (username, display_name, password_hash, role, must_change_password)
                VALUES ($1, $2, $3, $4::user_role, true)
                ON CONFLICT (username) DO NOTHING
                RETURNING id, true AS inserted
             )
             SELECT id, inserted FROM ins
             UNION ALL
             SELECT id, false FROM app_user WHERE username = $1 AND NOT EXISTS (SELECT 1 FROM ins)",
        )
        .bind(&username)
        .bind(&display_name)
        .bind(&hash)
        .bind(map_role(&role))
        .fetch_one(&mut *tx)
        .await?;

        new_user_id_by_old_id.insert(old_id as i64, id);
        if inserted {
            summary.users += 1;
            summary.credentials.push(ImportedCredential {
                username,
                display_name,
                temp_password,
            });
        }
    }

    // --------------------------------------------------------------- products
    let old_products = sqlx::query(
        "SELECT id, name, sku, category, unit_type, buying_price, selling_price, price,
                minimum_quantity, is_active, created_at
         FROM products ORDER BY id",
    )
    .fetch_all(&source)
    .await
    .map_err(|e| DbError::Conflict(format!("could not read old products: {e}")))?;

    let mut new_product_id_by_old_id: HashMap<i64, i64> = HashMap::new();
    let mut base_unit_id_by_old_product_id: HashMap<i64, i64> = HashMap::new();

    for row in &old_products {
        let old_id: i32 = row.get("id");
        let name: String = row.get("name");
        let sku: Option<String> = row.try_get("sku").ok();
        let category: Option<String> = row.try_get("category").ok();
        let unit_type: Option<String> = row.try_get("unit_type").ok();
        let buying_price: Option<Decimal> = row.try_get("buying_price").ok();
        let selling_price: Option<Decimal> = row.try_get("selling_price").ok();
        let price: Decimal = row.get("price");
        let minimum_quantity: Option<i32> = row.try_get("minimum_quantity").ok();
        let is_active: bool = row.get("is_active");
        let created_at: Option<NaiveDateTime> = row.try_get("created_at").ok();

        let unit_code = map_unit_code(unit_type.as_deref().unwrap_or("items"));
        let base_unit_id = *unit_id_by_code
            .get(unit_code)
            .ok_or_else(|| DbError::Conflict(format!("unit '{unit_code}' is missing from this app's database")))?;
        let category_id = category
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .and_then(|c| category_id_by_name.get(c).copied());

        let cost_price = buying_price.unwrap_or(Decimal::ZERO);
        let sell_price = selling_price.filter(|d| !d.is_zero()).unwrap_or(price);
        let low_stock_at = Decimal::from(minimum_quantity.unwrap_or(0).max(0));
        let created_at = created_at.map(as_utc).unwrap_or_else(Utc::now);

        let new_id: i64 = sqlx::query_scalar(
            "INSERT INTO product
                (sku, name, category_id, base_unit_id, cost_price, selling_price,
                 low_stock_at, active, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name
             RETURNING id",
        )
        .bind(&sku)
        .bind(&name)
        .bind(category_id)
        .bind(base_unit_id)
        .bind(cost_price)
        .bind(sell_price)
        .bind(low_stock_at)
        .bind(is_active)
        .bind(created_at)
        .fetch_one(&mut *tx)
        .await?;

        new_product_id_by_old_id.insert(old_id as i64, new_id);
        base_unit_id_by_old_product_id.insert(old_id as i64, base_unit_id);
        summary.products += 1;
    }

    // ------------------------------------------------------- price variations
    let old_variations = sqlx::query(
        "SELECT product_id, variant_name, price, sort_order
         FROM product_price_variations WHERE is_active ORDER BY product_id, sort_order",
    )
    .fetch_all(&source)
    .await
    .map_err(|e| DbError::Conflict(format!("could not read old price variations: {e}")))?;

    for row in &old_variations {
        let old_product_id: i32 = row.get("product_id");
        let Some(&product_id) = new_product_id_by_old_id.get(&(old_product_id as i64)) else {
            continue;
        };
        let variant_name: String = row.get("variant_name");
        let price: Decimal = row.get("price");
        let sort_order: Option<i32> = row.try_get("sort_order").ok();

        sqlx::query(
            "INSERT INTO product_price_option (product_id, label, price, sort_order)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(product_id)
        .bind(&variant_name)
        .bind(price)
        .bind(sort_order.unwrap_or(0))
        .execute(&mut *tx)
        .await?;
        summary.price_options += 1;
    }

    // ----------------------------------------------------------- customers
    let old_customers = sqlx::query(
        "SELECT id, first_name, last_name, phone, points_balance, created_at FROM customers ORDER BY id",
    )
    .fetch_all(&source)
    .await
    .map_err(|e| DbError::Conflict(format!("could not read old customers: {e}")))?;

    let mut new_customer_id_by_old_id: HashMap<i64, i64> = HashMap::new();
    for row in &old_customers {
        let old_id: i32 = row.get("id");
        let first_name: String = row.get("first_name");
        let last_name: String = row.get("last_name");
        let phone: Option<String> = row.try_get("phone").ok();
        let points_balance: Option<i32> = row.try_get("points_balance").ok();
        let created_at: Option<NaiveDateTime> = row.try_get("created_at").ok();

        let name = format!("{first_name} {last_name}").trim().to_string();
        let name = if name.is_empty() { "Unnamed".to_string() } else { name };
        let loyalty_points = Decimal::from(points_balance.unwrap_or(0));
        let created_at = created_at.map(as_utc).unwrap_or_else(Utc::now);

        let new_id: i64 = sqlx::query_scalar(
            "INSERT INTO customer (name, phone, loyalty_points, created_at)
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(&name)
        .bind(&phone)
        .bind(loyalty_points)
        .bind(created_at)
        .fetch_one(&mut *tx)
        .await?;
        new_customer_id_by_old_id.insert(old_id as i64, new_id);
        summary.customers += 1;
    }

    // --------------------------------------------------------------- sales
    let old_sales = sqlx::query(
        "SELECT id, product_id, quantity, unit_price, original_price, discount_amount,
                total_amount, buying_price_at_sale, customer_id, created_by, payment_method,
                sale_date, created_at
         FROM sales ORDER BY id",
    )
    .fetch_all(&source)
    .await
    .map_err(|e| DbError::Conflict(format!("could not read old sales: {e}")))?;

    let mut new_sale_id_by_old_sale_id: HashMap<i64, i64> = HashMap::new();
    for row in &old_sales {
        let old_id: i32 = row.get("id");
        let old_product_id: i32 = row.get("product_id");
        let quantity: Decimal = row.get("quantity");
        let unit_price: Decimal = row.get("unit_price");
        let original_price: Decimal = row.get("original_price");
        let discount_amount: Option<Decimal> = row.try_get("discount_amount").ok();
        let total_amount: Decimal = row.get("total_amount");
        let buying_price_at_sale: Option<Decimal> = row.try_get("buying_price_at_sale").ok();
        let customer_id: Option<i32> = row.try_get("customer_id").ok();
        let created_by: Option<i32> = row.try_get("created_by").ok();
        let payment_method: Option<String> = row.try_get("payment_method").ok();
        let sale_date: Option<NaiveDateTime> = row.try_get("sale_date").ok();
        let created_at: Option<NaiveDateTime> = row.try_get("created_at").ok();

        let customer_id = customer_id.and_then(|id| new_customer_id_by_old_id.get(&(id as i64)).copied());
        let created_by_id = created_by.and_then(|id| new_user_id_by_old_id.get(&(id as i64)).copied());
        let discount_total = discount_amount.unwrap_or(Decimal::ZERO);
        let subtotal = original_price * quantity;
        let created_at = sale_date.or(created_at).map(as_utc).unwrap_or_else(Utc::now);
        let invoice_number = format!("AGP-{old_id}");

        let inserted: Option<i64> = sqlx::query_scalar(
            "INSERT INTO sale
                (invoice_number, location_id, customer_id, status, subtotal,
                 discount_total, grand_total, balance_due, created_at, completed_at, created_by)
             VALUES ($1, $2, $3, 'completed', $4, $5, $6, 0, $7, $7, $8)
             ON CONFLICT (invoice_number) DO NOTHING
             RETURNING id",
        )
        .bind(&invoice_number)
        .bind(location_id)
        .bind(customer_id)
        .bind(subtotal)
        .bind(discount_total)
        .bind(total_amount)
        .bind(created_at)
        .bind(created_by_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(sale_id) = inserted else { continue }; // already migrated
        new_sale_id_by_old_sale_id.insert(old_id as i64, sale_id);
        summary.sales += 1;

        let Some(&product_id) = new_product_id_by_old_id.get(&(old_product_id as i64)) else {
            continue; // product no longer resolvable; sale header kept, no line
        };
        let unit_id = base_unit_id_by_old_product_id
            .get(&(old_product_id as i64))
            .copied()
            .unwrap_or_else(|| *unit_id_by_code.get("pc").unwrap());
        let unit_cost = buying_price_at_sale.unwrap_or(Decimal::ZERO);

        sqlx::query(
            "INSERT INTO sale_line
                (sale_id, product_id, unit_id, quantity, unit_price, unit_cost, discount_amount, line_total)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(sale_id)
        .bind(product_id)
        .bind(unit_id)
        .bind(quantity)
        .bind(unit_price)
        .bind(unit_cost)
        .bind(discount_total)
        .bind(total_amount)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO sale_payment (sale_id, method, amount, created_at)
             VALUES ($1, $2::payment_method, $3, $4)",
        )
        .bind(sale_id)
        .bind(map_payment_method(payment_method.as_deref().unwrap_or("cash")))
        .bind(total_amount)
        .bind(created_at)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO stock_movement
                (product_id, location_id, quantity, reason, unit_cost, ref_table, ref_id, created_at, created_by)
             VALUES ($1, $2, $3, 'sale', $4, 'sale', $5, $6, $7)",
        )
        .bind(product_id)
        .bind(location_id)
        .bind(-quantity)
        .bind(unit_cost)
        .bind(sale_id)
        .bind(created_at)
        .bind(created_by_id)
        .execute(&mut *tx)
        .await?;
    }

    // ------------------------------------------------------------- returns
    let old_returns = sqlx::query(
        "SELECT sale_id, product_id, quantity_returned, return_reason, refund_amount,
                restocked, return_date, created_at, processed_by
         FROM product_returns ORDER BY id",
    )
    .fetch_all(&source)
    .await
    .map_err(|e| DbError::Conflict(format!("could not read old returns: {e}")))?;

    for row in &old_returns {
        let old_sale_id: i32 = row.get("sale_id");
        let old_product_id: i32 = row.get("product_id");
        let quantity_returned: Decimal = row.get("quantity_returned");
        let return_reason: Option<String> = row.try_get("return_reason").ok();
        let refund_amount: Decimal = row.get("refund_amount");
        let restocked: Option<bool> = row.try_get("restocked").ok();
        let return_date: Option<NaiveDateTime> = row.try_get("return_date").ok();
        let created_at: Option<NaiveDateTime> = row.try_get("created_at").ok();
        let processed_by: Option<i32> = row.try_get("processed_by").ok();

        let Some(&sale_id) = new_sale_id_by_old_sale_id.get(&(old_sale_id as i64)) else {
            continue; // parent sale wasn't migrated (e.g. re-run after partial failure)
        };
        let sale_line_id: Option<i64> = sqlx::query_scalar("SELECT id FROM sale_line WHERE sale_id = $1 LIMIT 1")
            .bind(sale_id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(sale_line_id) = sale_line_id else { continue };

        let created_by_id = processed_by.and_then(|id| new_user_id_by_old_id.get(&(id as i64)).copied());
        let created_at = return_date.or(created_at).map(as_utc).unwrap_or_else(Utc::now);

        let return_id: i64 = sqlx::query_scalar(
            "INSERT INTO sale_return (sale_id, status, reason, total, created_at, created_by)
             VALUES ($1, 'completed', $2, $3, $4, $5) RETURNING id",
        )
        .bind(sale_id)
        .bind(&return_reason)
        .bind(refund_amount)
        .bind(created_at)
        .bind(created_by_id)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO sale_return_line (sale_return_id, sale_line_id, quantity, line_total)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(return_id)
        .bind(sale_line_id)
        .bind(quantity_returned)
        .bind(refund_amount)
        .execute(&mut *tx)
        .await?;

        if restocked.unwrap_or(true) {
            if let Some(&product_id) = new_product_id_by_old_id.get(&(old_product_id as i64)) {
                sqlx::query(
                    "INSERT INTO stock_movement
                        (product_id, location_id, quantity, reason, ref_table, ref_id, created_at, created_by)
                     VALUES ($1, $2, $3, 'sale_return', 'sale_return', $4, $5, $6)",
                )
                .bind(product_id)
                .bind(location_id)
                .bind(quantity_returned)
                .bind(return_id)
                .bind(created_at)
                .bind(created_by_id)
                .execute(&mut *tx)
                .await?;
            }
        }
        summary.returns += 1;
    }

    // ------------------------------------------------------- restock history
    let old_restocks = sqlx::query(
        "SELECT product_id, quantity_added, notes, restocked_at, restocked_by
         FROM restock_history ORDER BY product_id, restocked_at",
    )
    .fetch_all(&source)
    .await
    .map_err(|e| DbError::Conflict(format!("could not read old restock history: {e}")))?;

    for row in &old_restocks {
        let old_product_id: i32 = row.get("product_id");
        let Some(&product_id) = new_product_id_by_old_id.get(&(old_product_id as i64)) else {
            continue;
        };
        let quantity_added: i32 = row.get("quantity_added");
        let notes: Option<String> = row.try_get("notes").ok();
        let restocked_at: Option<NaiveDateTime> = row.try_get("restocked_at").ok();
        let restocked_by: Option<i32> = row.try_get("restocked_by").ok();
        let created_by_id = restocked_by.and_then(|id| new_user_id_by_old_id.get(&(id as i64)).copied());
        let created_at = restocked_at.map(as_utc).unwrap_or_else(Utc::now);

        sqlx::query(
            "INSERT INTO stock_movement (product_id, location_id, quantity, reason, note, created_at, created_by)
             VALUES ($1, $2, $3, 'purchase', $4, $5, $6)",
        )
        .bind(product_id)
        .bind(location_id)
        .bind(Decimal::from(quantity_added))
        .bind(&notes)
        .bind(created_at)
        .bind(created_by_id)
        .execute(&mut *tx)
        .await?;
        summary.restock_movements += 1;
    }

    // ---------------------------------------------- opening-balance plug
    // Reconcile: current stock_quantity on the old product minus everything
    // just replayed (restocks - sales + restocked returns) becomes one
    // 'opening' movement, so SUM(stock_movement.quantity) ends up exactly
    // equal to the old system's stock_quantity for every product.
    let old_stock = sqlx::query("SELECT id, stock_quantity FROM products")
        .fetch_all(&source)
        .await
        .map_err(|e| DbError::Conflict(format!("could not read old stock levels: {e}")))?;

    for row in &old_stock {
        let old_id: i32 = row.get("id");
        let Some(&product_id) = new_product_id_by_old_id.get(&(old_id as i64)) else {
            continue;
        };
        let target: i32 = row.get("stock_quantity");
        let replayed: Decimal = sqlx::query_scalar(
            "SELECT COALESCE(SUM(quantity), 0) FROM stock_movement WHERE product_id = $1 AND location_id = $2",
        )
        .bind(product_id)
        .bind(location_id)
        .fetch_one(&mut *tx)
        .await?;
        let plug = Decimal::from(target) - replayed;
        if !plug.is_zero() {
            sqlx::query(
                "INSERT INTO stock_movement (product_id, location_id, quantity, reason, note, created_at)
                 VALUES ($1, $2, $3, 'opening', 'AgroPlus import opening balance', now())",
            )
            .bind(product_id)
            .bind(location_id)
            .bind(plug)
            .execute(&mut *tx)
            .await?;
            summary.opening_plugs += 1;
        }
    }

    tx.commit().await?;
    source.close().await;
    Ok(summary)
}
