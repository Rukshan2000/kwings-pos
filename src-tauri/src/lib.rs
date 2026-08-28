pub mod db;
pub mod domain;
pub mod catalogue;
pub mod inventory;
pub mod purchasing;
pub mod pos;
mod printing;

use tauri::{Emitter, Manager};

use db::{AppDb, BootstrapError, Db};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppDb::empty())
        .manage(BootstrapError::empty())
        .invoke_handler(tauri::generate_handler![
            printing::list_printers,
            printing::print_raw,
            db::commands::db_status,
            db::commands::db_health,
            db::commands::backup_now,
            catalogue::list_categories,
            catalogue::create_category,
            catalogue::list_brands,
            catalogue::create_brand,
            catalogue::list_units,
            catalogue::list_products,
            catalogue::get_product,
            catalogue::create_product,
            catalogue::update_product,
            catalogue::archive_product,
            catalogue::set_product_unit,
            catalogue::set_price_tier,
            inventory::stock_levels,
            inventory::stock_movements,
            inventory::stock_valuation,
            inventory::record_opening_stock,
            inventory::adjust_stock,
            purchasing::list_suppliers,
            purchasing::create_supplier,
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
