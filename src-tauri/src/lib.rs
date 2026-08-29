pub mod auth;
pub mod db;
pub mod domain;
pub mod catalogue;
pub mod inventory;
pub mod loyalty;
pub mod purchasing;
pub mod pos;
pub mod reconciliation;
pub mod reports;
pub mod returns;
mod printing;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use db::{AppDb, BootstrapError, Db};

/// Opens the customer-facing display, or focuses it if a cashier already has
/// it open — a second click should not spawn a second window. It loads the
/// same SPA bundle as the till; `main.tsx` picks which tree to render by
/// checking the window's own label, so no separate route or HTML entry is
/// needed.
#[tauri::command]
async fn open_customer_display(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("customer") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "customer", WebviewUrl::App("index.html".into()))
        .title("Customer Display")
        .inner_size(1024.0, 700.0)
        .min_inner_size(640.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppDb::empty())
        .manage(BootstrapError::empty())
        .manage(auth::SessionState::empty())
        .invoke_handler(tauri::generate_handler![
            open_customer_display,
            auth::login,
            auth::logout,
            auth::current_user,
            auth::change_password,
            auth::list_users,
            auth::create_user,
            auth::set_user_role,
            auth::set_user_active,
            auth::reset_user_password,
            printing::list_printers,
            printing::print_raw,
            db::commands::db_status,
            db::commands::db_health,
            db::commands::backup_now,
            catalogue::list_categories,
            catalogue::create_category,
            catalogue::update_category_color,
            catalogue::archive_category,
            catalogue::list_brands,
            catalogue::create_brand,
            catalogue::archive_brand,
            catalogue::list_units,
            catalogue::create_unit,
            catalogue::archive_unit,
            catalogue::list_products,
            catalogue::get_product,
            catalogue::create_product,
            catalogue::update_product,
            catalogue::archive_product,
            catalogue::restore_product,
            catalogue::set_product_unit,
            catalogue::set_price_tier,
            catalogue::set_price_option,
            catalogue::delete_price_option,
            inventory::stock_levels,
            inventory::stock_movements,
            inventory::stock_valuation,
            inventory::record_opening_stock,
            inventory::adjust_stock,
            loyalty::list_customers,
            loyalty::create_customer,
            loyalty::archive_customer,
            loyalty::loyalty_setting,
            loyalty::update_loyalty_setting,
            purchasing::list_suppliers,
            purchasing::create_supplier,
            purchasing::archive_supplier,
            purchasing::list_purchases,
            purchasing::get_purchase,
            purchasing::create_purchase,
            purchasing::receive_purchase,
            purchasing::record_purchase_payment,
            purchasing::return_purchase_lines,
            pos::hold_sale,
            pos::list_held_sales,
            pos::held_sale,
            pos::cancel_held_sale,
            pos::complete_sale,
            pos::sale_receipt,
            reports::revenue_report,
            reports::sales_by_product,
            reports::profit_summary,
            reports::payment_breakdown,
            reports::purchases_report,
            reports::stock_summary,
            reports::sales_by_cashier,
            reports::my_sales,
            reconciliation::daily_reconciliation,
            reconciliation::save_opening_count,
            reconciliation::save_closing_count,
            reconciliation::list_reconciliations,
            returns::find_sale_for_return,
            returns::create_return,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let resource_dir = app.path().resource_dir().ok();

            // Starting PostgreSQL takes seconds on a warm cluster and far longer on
            // the very first launch (initdb). Doing it here rather than blocking
            // setup lets the window paint and show progress.
            tauri::async_runtime::spawn(async move {
                match Db::bootstrap(resource_dir).await {
                    Ok(database) => {
                        let state = handle.state::<AppDb>();
                        *state.0.write().await = Some(database);
                        let _ = handle.emit("db-ready", ());
                    }
                    Err(e) => {
                        eprintln!("database bootstrap failed: {e}");
                        let message = e.to_string();
                        let error_state = handle.state::<BootstrapError>();
                        *error_state.0.write().await = Some(message.clone());
                        let _ = handle.emit("db-error", message);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| {
            // Shut PostgreSQL down cleanly on the way out. The Job Object still
            // covers the crash case, but a `fast` stop avoids recovery on restart.
            if let tauri::RunEvent::Exit = event {
                let handle = handle.clone();
                tauri::async_runtime::block_on(async move {
                    let state = handle.state::<AppDb>();
                    let taken = state.0.write().await.take();
                    if let Some(database) = taken {
                        database.shutdown().await;
                    }
                });
            }
        });
}
