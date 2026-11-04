#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, RunEvent};

fn data_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        // sviluppo: cameras.json nella cartella del progetto
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().ok_or("progetto senza cartella")?.to_path_buf())
    } else {
        // portable: dati in "data" accanto all'exe
        Ok(std::env::current_exe()?.parent().ok_or("exe senza cartella")?.join("data"))
    }
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            app.manage(server::Backend::start(data_dir()?)?);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("errore avvio app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Arc<server::Backend>>().kill_all();
        }
    });
}
