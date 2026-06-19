mod sidecar;
mod database;

use tauri::Manager;

pub struct ChildProcesses {
    pub children: std::sync::Mutex<Vec<std::process::Child>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().build())
    .invoke_handler(tauri::generate_handler![
        database::get_paths_info,
        database::get_file_events,
        database::get_all_unique_files,
        database::get_monitored_apps,
        database::clear_logs,
        database::get_system_metrics,
        database::get_watch_targets,
        database::add_watch_target,
        database::remove_watch_target,
        database::get_standard_paths,
        database::open_in_explorer,
        database::get_running_processes,
        database::get_global_mode,
        database::set_global_mode,
        database::get_ignore_system_apps,
        database::set_ignore_system_apps,
        database::exit_app,
        database::get_db_size
    ])
    .setup(|app| {
        // Tray Setup
        let show_i = tauri::menu::MenuItem::with_id(app, "show", "Show File Monitor", true, None::<&str>)?;
        let quit_i = tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = tauri::menu::Menu::with_items(app, &[&show_i, &quit_i])?;

        let _tray = tauri::tray::TrayIconBuilder::new()
            .icon(app.default_window_icon().unwrap().clone())
            .menu(&menu)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "quit" => {
                    std::process::exit(0);
                }
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let tauri::tray::TrayIconEvent::Click { .. } = event {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            })
            .build(app)?;

        // Resolve target SQLite database path
        let local_data = app.path().app_local_data_dir().unwrap();
        std::fs::create_dir_all(&local_data).unwrap();
        let db_path = local_data.join("file_monitor.db");
        let db_path_str = db_path.to_string_lossy().to_string();

        // Initialize SQLite tables in Rust on startup to prevent UI race conditions
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            let _ = conn.execute(
                "CREATE TABLE IF NOT EXISTS monitored_apps (
                    pid INTEGER PRIMARY KEY,
                    process_name TEXT NOT NULL,
                    executable_path TEXT,
                    first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )",
                [],
            );
            let _ = conn.execute(
                "CREATE TABLE IF NOT EXISTS file_events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    pid INTEGER,
                    file_path TEXT NOT NULL,
                    operation_type TEXT NOT NULL,
                    FOREIGN KEY(pid) REFERENCES monitored_apps(pid) ON DELETE SET NULL
                )",
                [],
            );
            let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_file_events_timestamp ON file_events(timestamp)", []);
            let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_file_events_path ON file_events(file_path)", []);
            let _ = conn.execute(
                "CREATE TABLE IF NOT EXISTS watch_targets (
                    path TEXT PRIMARY KEY,
                    added_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )",
                [],
            );
            let _ = conn.execute(
                "CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )",
                [],
            );
            let _ = conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES ('global_mode', 'true')",
                [],
            );
        }

        // Resolve workspace monitoring folder path (at workspace root level)
        let mut root_path = std::env::current_dir().unwrap();
        if root_path.to_string_lossy().ends_with("src-tauri") {
            root_path = root_path.parent().unwrap().to_path_buf();
        }
        let watch_dir = root_path.join("watched_folder");
        std::fs::create_dir_all(&watch_dir).unwrap();
        let watch_dir_str = watch_dir.to_string_lossy().to_string();

        // No default watch targets populated in database for release builds

        // Store application paths state in Tauri manager
        app.manage(database::AppPaths {
            watch_dir: watch_dir_str.clone(),
            db_path: db_path_str.clone(),
        });

        // Store child processes state for clean lifecycle shutdown
        app.manage(ChildProcesses {
            children: std::sync::Mutex::new(Vec::new()),
        });

        let handle = app.handle().clone();
        
        // Spawn the C++ ETW monitor subprocess
        sidecar::spawn_etw_process(handle, db_path_str);

        Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<ChildProcesses>() {
                let mut children = state.children.lock().unwrap();
                for mut child in children.drain(..) {
                    let _ = child.kill();
                }
            }
        }
    });
}
// Force reload sidecar

