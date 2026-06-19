use rusqlite::{Connection, Result};
use serde::{Serialize, Deserialize};
use tauri::Manager;
use std::collections::HashMap;
use std::sync::Mutex;
use lazy_static::lazy_static;
use std::io::Cursor;
use base64::{Engine as _, engine::general_purpose};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct AppPaths {
    pub watch_dir: String,
    pub db_path: String,
}

lazy_static! {
    static ref ICON_CACHE: Mutex<HashMap<String, Option<String>>> = Mutex::new(HashMap::new());
}

fn get_process_icon_base64(exe_path: &str) -> Option<String> {
    if exe_path.is_empty() {
        return None;
    }
    
    let mut cache = ICON_CACHE.lock().unwrap();
    if let Some(cached) = cache.get(exe_path) {
        return cached.clone();
    }
    
    let p = std::path::Path::new(exe_path);
    if !p.exists() {
        cache.insert(exe_path.to_string(), None);
        return None;
    }

    let result = (|| -> Option<String> {
        let img_buffer = windows_icons::get_icon_by_path(p).ok()?;
        let dyn_img = image::DynamicImage::ImageRgba8(img_buffer);
        let mut bytes: Vec<u8> = Vec::new();
        dyn_img.write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png).ok()?;
        Some(general_purpose::STANDARD.encode(&bytes))
    })();

    cache.insert(exe_path.to_string(), result.clone());
    result
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProcessInfo {
    pub pid: i32,
    pub process_name: String,
    pub executable_path: String,
    pub first_seen: String,
    pub last_seen: String,
    pub icon_base64: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEventInfo {
    pub event_id: i32,
    pub timestamp: String,
    pub pid: Option<i32>,
    pub process_name: Option<String>,
    pub file_path: String,
    pub operation_type: String,
}

fn get_conn(db_path: &str) -> Result<Connection> {
    Connection::open(db_path)
}

#[tauri::command]
pub fn get_paths_info(state: tauri::State<'_, AppPaths>) -> AppPaths {
    state.inner().clone()
}

#[tauri::command]
pub fn get_file_events(state: tauri::State<'_, AppPaths>) -> Result<Vec<FileEventInfo>, String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    
    let mut stmt = conn.prepare(
        "SELECT e.event_id, e.timestamp, e.pid, a.process_name, e.file_path, e.operation_type \
         FROM file_events e \
         LEFT JOIN monitored_apps a ON e.pid = a.pid \
         ORDER BY e.timestamp DESC LIMIT 1000"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(FileEventInfo {
            event_id: row.get(0)?,
            timestamp: row.get(1)?,
            pid: row.get(2)?,
            process_name: row.get(3)?,
            file_path: row.get(4)?,
            operation_type: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut list = Vec::new();
    for r in rows {
        if let Ok(item) = r {
            list.push(item);
        }
    }
    Ok(list)
}

#[tauri::command]
pub fn get_all_unique_files(state: tauri::State<'_, AppPaths>) -> Result<Vec<FileEventInfo>, String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    
    // SQLite grouping to perfectly deduplicate thousands of repetitive file logs!
    let mut stmt = conn.prepare(
        "SELECT e.event_id, MAX(e.timestamp) as timestamp, e.pid, a.process_name, e.file_path, e.operation_type \
         FROM file_events e \
         LEFT JOIN monitored_apps a ON e.pid = a.pid \
         GROUP BY a.process_name, e.file_path \
         ORDER BY timestamp DESC LIMIT 5000"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(FileEventInfo {
            event_id: row.get(0)?,
            timestamp: row.get(1)?,
            pid: row.get(2)?,
            process_name: row.get(3)?,
            file_path: row.get(4)?,
            operation_type: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut list = Vec::new();
    for r in rows {
        if let Ok(item) = r {
            list.push(item);
        }
    }
    Ok(list)
}

#[tauri::command]
pub fn get_monitored_apps(state: tauri::State<'_, AppPaths>) -> Result<Vec<ProcessInfo>, String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT pid, process_name, executable_path, first_seen, last_seen \
         FROM monitored_apps \
         ORDER BY last_seen DESC"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        let exe: String = row.get(2).unwrap_or_default();
        Ok(ProcessInfo {
            pid: row.get(0)?,
            process_name: row.get(1)?,
            icon_base64: get_process_icon_base64(&exe),
            executable_path: exe,
            first_seen: row.get(3)?,
            last_seen: row.get(4)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut list = Vec::new();
    for r in rows {
        if let Ok(item) = r {
            list.push(item);
        }
    }
    Ok(list)
}

#[tauri::command]
pub fn clear_logs(state: tauri::State<'_, AppPaths>) -> Result<(), String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM file_events", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM monitored_apps", []).map_err(|e| e.to_string())?;
    conn.execute("VACUUM", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_watch_targets(state: tauri::State<'_, AppPaths>) -> Result<Vec<String>, String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT path FROM watch_targets ORDER BY added_time ASC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
    let mut list = Vec::new();
    for r in rows {
        if let Ok(item) = r {
            list.push(item);
        }
    }
    Ok(list)
}

#[tauri::command]
pub fn add_watch_target(state: tauri::State<'_, AppPaths>, path: String) -> Result<(), String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    let p = std::path::Path::new(trimmed);
    if !p.exists() {
        return Err(format!("Directory does not exist: '{}'", trimmed));
    }
    if !p.is_dir() {
        return Err(format!("Path is not a directory: '{}'", trimmed));
    }
    let canonical = p.canonicalize().map_err(|e| format!("Failed to resolve path: {}", e))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    
    // Strip UNC path prefix (\\?\) on Windows
    let clean_path = if canonical_str.starts_with(r"\\?\") {
        canonical_str[4..].to_string()
    } else {
        canonical_str
    };

    conn.execute("INSERT OR IGNORE INTO watch_targets (path) VALUES (?)", [&clean_path]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_watch_target(state: tauri::State<'_, AppPaths>, path: String) -> Result<(), String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM watch_targets WHERE path = ?", [&path]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct StandardPaths {
    pub desktop: String,
    pub documents: String,
    pub downloads: String,
}

#[tauri::command]
pub fn get_standard_paths(app: tauri::AppHandle) -> Result<StandardPaths, String> {
    let path_resolver = app.path();
    let desktop = path_resolver.desktop_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let documents = path_resolver.document_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let downloads = path_resolver.download_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    Ok(StandardPaths {
        desktop,
        documents,
        downloads,
    })
}

#[derive(Serialize, Clone, Debug)]
pub struct DiskInfo {
    pub name: String,
    pub used_gb: f64,
    pub total_gb: f64,
    pub usage_percent: f32,
}

#[derive(Serialize, Clone, Debug)]
pub struct SystemMetrics {
    pub cpu_usage: f32,
    pub ram_used_gb: f64,
    pub ram_total_gb: f64,
    pub ram_usage_percent: f32,
    pub disks: Vec<DiskInfo>,
}

#[tauri::command]
pub fn get_system_metrics() -> SystemMetrics {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    
    let cpu_usage = sys.global_cpu_info().cpu_usage();
    
    let ram_used = sys.used_memory();
    let ram_total = sys.total_memory();
    let ram_used_gb = ram_used as f64 / 1_073_741_824.0;
    let ram_total_gb = ram_total as f64 / 1_073_741_824.0;
    let ram_usage_percent = if ram_total > 0 {
        (ram_used as f32 / ram_total as f32) * 100.0
    } else {
        0.0
    };
    
    let mut disks_info = Vec::new();
    let disks = sysinfo::Disks::new_with_refreshed_list();
    for disk in &disks {
        let name = disk.mount_point().to_string_lossy().to_string();
        let total = disk.total_space();
        let available = disk.available_space();
        let used = total - available;
        
        let used_gb = used as f64 / 1_073_741_824.0;
        let total_gb = total as f64 / 1_073_741_824.0;
        let usage_percent = if total > 0 {
            (used as f32 / total as f32) * 100.0
        } else {
            0.0
        };
        
        disks_info.push(DiskInfo {
            name,
            used_gb,
            total_gb,
            usage_percent,
        });
    }
    
    SystemMetrics {
        cpu_usage,
        ram_used_gb,
        ram_total_gb,
        ram_usage_percent,
        disks: disks_info,
    }
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let normalized_path = path.replace('/', "\\");
    let mut p = std::path::PathBuf::from(&normalized_path);
    
    // Find the nearest ancestor directory that exists
    while !p.exists() {
        if let Some(parent) = p.parent() {
            p = parent.to_path_buf();
        } else {
            break;
        }
    }

    if !p.exists() {
        return Err("Path does not exist and no valid parent directory found".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer.exe");
        let orig_path = std::path::Path::new(&normalized_path);
        if orig_path.exists() && orig_path.is_file() {
            cmd.arg(format!("/select,{}", normalized_path));
        } else {
            cmd.arg(p.to_string_lossy().to_string());
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let show_cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(show_cmd)
            .arg(p.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct ProcessDetail {
    pub pid: u32,
    pub name: String,
    pub exe: String,
    pub memory_mb: u64,
    pub cpu_usage: f32,
    pub icon_base64: Option<String>,
}

#[tauri::command]
pub fn get_running_processes() -> Result<Vec<ProcessDetail>, String> {
    use sysinfo::{System};
    let mut sys = System::new_all();
    sys.refresh_processes();
    
    let mut list = Vec::new();
    let num_cores = sys.cpus().len() as f32;
    for (pid, process) in sys.processes() {
        let exe = process.exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let icon_base64 = get_process_icon_base64(&exe);
        list.push(ProcessDetail {
            pid: pid.as_u32(),
            name: process.name().to_string(),
            exe,
            memory_mb: process.memory() / 1_048_576, // convert bytes to MB
            cpu_usage: process.cpu_usage() / num_cores.max(1.0),
            icon_base64,
        });
    }
    
    // Sort by memory usage
    list.sort_by(|a, b| b.memory_mb.cmp(&a.memory_mb));
    Ok(list)
}

#[tauri::command]
pub fn get_global_mode(state: tauri::State<'_, AppPaths>) -> Result<bool, String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = 'global_mode'").map_err(|e| e.to_string())?;
    let val: String = stmt.query_row([], |row| row.get(0)).unwrap_or_else(|_| "false".to_string());
    Ok(val == "true")
}

#[tauri::command]
pub fn set_global_mode(state: tauri::State<'_, AppPaths>, enabled: bool) -> Result<(), String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    let val_str = if enabled { "true" } else { "false" };
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('global_mode', ?1)", [val_str]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_ignore_system_apps(state: tauri::State<'_, AppPaths>) -> Result<bool, String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = 'ignore_system'").map_err(|e| e.to_string())?;
    let val: String = stmt.query_row([], |row| row.get(0)).unwrap_or_else(|_| "true".to_string());
    Ok(val == "true")
}

#[tauri::command]
pub fn set_ignore_system_apps(state: tauri::State<'_, AppPaths>, ignore: bool) -> Result<(), String> {
    let conn = get_conn(&state.db_path).map_err(|e| e.to_string())?;
    let val_str = if ignore { "true" } else { "false" };
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('ignore_system', ?1)", [val_str]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn exit_app() {
    std::process::exit(0);
}

#[tauri::command]
pub fn get_db_size(state: tauri::State<'_, AppPaths>) -> Result<f64, String> {
    let metadata = std::fs::metadata(&state.db_path).map_err(|e| e.to_string())?;
    Ok(metadata.len() as f64 / 1_048_576.0)
}
