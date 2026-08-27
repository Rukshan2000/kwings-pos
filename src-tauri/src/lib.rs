mod printing;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            printing::list_printers,
            printing::print_raw
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
