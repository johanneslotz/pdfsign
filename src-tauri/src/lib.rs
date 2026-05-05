mod commands;

use commands::{file, pkcs11, sign};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            file::open_pdf_dialog,
            file::save_pdf_dialog,
            pkcs11::list_smartcard_certs,
            sign::sign_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
