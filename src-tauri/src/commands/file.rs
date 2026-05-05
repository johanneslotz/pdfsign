use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn open_pdf_dialog(app: AppHandle) -> Result<Option<(String, Vec<u8>)>, String> {
    let path: Option<PathBuf> = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .blocking_pick_file()
        .map(|p| p.into_path().ok())
        .unwrap_or(None);

    match path {
        None => Ok(None),
        Some(p) => {
            let name = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
            Ok(Some((name, bytes)))
        }
    }
}

#[tauri::command]
pub async fn save_pdf_dialog(
    app: AppHandle,
    bytes: Vec<u8>,
    suggested_name: String,
) -> Result<bool, String> {
    let path: Option<PathBuf> = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(&suggested_name)
        .blocking_save_file()
        .map(|p| p.into_path().ok())
        .unwrap_or(None);

    match path {
        None => Ok(false),
        Some(p) => {
            std::fs::write(&p, &bytes).map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
}
