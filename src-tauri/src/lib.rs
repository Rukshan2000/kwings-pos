pub mod db;
mod printing;

use tauri::{Emitter, Manager};

use db::{AppDb, Db};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppDb::empty())
        .invoke_handler(tauri::generate_handler![
            printing::list_printers,
            printing::print_raw,
            db::commands::db_status,
            db::commands::db_health,
            db::commands::backup_now,
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
                        let _ = handle.emit("db-error", e.to_string());
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
