use std::process::{Command, Stdio};
use std::io::{BufReader, BufRead, Write};
use tauri::{AppHandle, Emitter, Manager};
use serde::{Serialize, Deserialize};
use std::time::Duration;

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEvent {
    pub timestamp: String,
    pub pid: i32,
    pub process_name: String,
    pub file_path: String,
    pub operation_type: String,
}

pub fn spawn_java_process(app_handle: AppHandle, watch_dir: String, db_path: String) {
    let app_handle_clone = app_handle.clone();
    
    let resource_dir = app_handle_clone.path().resource_dir().expect("failed to get resource dir");
    let jar_path = resource_dir.join("binaries").join("monitor-core.jar");
        
    let jar_path_str = jar_path.to_string_lossy().to_string();

    tauri::async_runtime::spawn(async move {
        log::info!("Spawning Java sidecar: java -jar {} {} {}", jar_path_str, watch_dir, db_path);
        
        let mut cmd = Command::new("java");
        cmd.args(&["-jar", &jar_path_str, &watch_dir, &db_path])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn()
            .expect("Failed to spawn Java monitor process. Make sure Java is installed.");

        let stdout = child.stdout.take().expect("Failed to open Java stdout");
        let stderr = child.stderr.take().expect("Failed to open Java stderr");

        // Register child in global state for cleanup on exit
        if let Some(state) = app_handle_clone.try_state::<crate::ChildProcesses>() {
            state.children.lock().unwrap().push(child);
        }

        // Spawn background task to read and log stderr
        let reader_err = BufReader::new(stderr);
        tauri::async_runtime::spawn(async move {
            for line_result in reader_err.lines() {
                if let Ok(line) = line_result {
                    log::error!("[Java Stderr]: {}", line);
                }
            }
        });

        let reader = BufReader::new(stdout);
        for line_result in reader.lines() {
            if let Ok(line) = line_result {
                // Parse stdout JSON
                if let Ok(log_val) = serde_json::from_str::<serde_json::Value>(&line) {
                    // Emit log event to React
                    let _ = app_handle_clone.emit("java-log", log_val);
                } else {
                    log::info!("[Java Raw Stdout]: {}", line);
                }
            }
        }
        log::info!("Java stdout reader finished.");
    });
}

pub fn spawn_etw_process(app_handle: AppHandle, db_path: String) {
    let app_handle_clone = app_handle.clone();
    
    let resource_dir = app_handle_clone.path().resource_dir().expect("failed to get resource dir");
    let exe_path = resource_dir.join("binaries").join("main.exe");
        
    let exe_path_str = exe_path.to_string_lossy().to_string();

    tauri::async_runtime::spawn(async move {
        log::info!("Spawning C++ ETW sidecar: {}", exe_path_str);
        
        let mut cmd = Command::new(&exe_path_str);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let child = cmd.spawn();

        if child.is_err() {
            log::error!("Failed to spawn ETW monitor. Ensure main.exe is built.");
            return;
        }
        let mut child = child.unwrap();

        let mut stdin = child.stdin.take().expect("Failed to open ETW stdin");
        let app_clone_for_stdin = app_handle_clone.clone();
        
        // Background thread to sync targets and global mode to ETW stdin
        std::thread::spawn(move || {
            let mut last_global_mode = None;
            let mut last_targets = Vec::new();

            loop {
                std::thread::sleep(Duration::from_secs(2));
                if let Some(state) = app_clone_for_stdin.try_state::<crate::database::AppPaths>() {
                    // Query global mode
                    let global_mode = crate::database::get_global_mode(state.clone()).unwrap_or(false);
                    if Some(global_mode) != last_global_mode {
                        let msg = if global_mode { "GLOBAL:ON" } else { "GLOBAL:OFF" };
                        let _ = writeln!(stdin, "{}", msg);
                        last_global_mode = Some(global_mode);
                    }

                    // Query targets
                    if let Ok(targets) = crate::database::get_watch_targets(state.clone()) {
                        if targets != last_targets {
                            let _ = writeln!(stdin, "CLEAR");
                            for target in &targets {
                                let _ = writeln!(stdin, "ADD:{}", target);
                            }
                            last_targets = targets;
                        }
                        let ignore_system = crate::database::get_ignore_system_apps(state.clone()).unwrap_or(false);
                        let cmd = if ignore_system { "IGNORE_SYS:1" } else { "IGNORE_SYS:0" };
                        let _ = writeln!(stdin, "{}", cmd);
                    }
                }
            }
        });

        // Background thread to clean up the database to prevent infinite bloat (keeps last 10,000 events)
        let db_path_cleanup = db_path.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(300)); // Every 5 minutes
                if let Ok(conn) = rusqlite::Connection::open(&db_path_cleanup) {
                    let _ = conn.execute("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;", []);
                    let _ = conn.execute(
                        "DELETE FROM file_events WHERE event_id NOT IN (
                            SELECT event_id FROM file_events ORDER BY event_id DESC LIMIT 10000
                        )",
                        [],
                    );
                }
            }
        });

        let stdout = child.stdout.take().expect("Failed to open ETW stdout");
        let stderr = child.stderr.take().expect("Failed to open ETW stderr");

        // Register child in global state for cleanup on exit
        if let Some(state) = app_handle_clone.try_state::<crate::ChildProcesses>() {
            state.children.lock().unwrap().push(child);
        }

        // Spawn background task to read and log stderr
        let reader_err = BufReader::new(stderr);
        tauri::async_runtime::spawn(async move {
            for line_result in reader_err.lines() {
                if let Ok(line) = line_result {
                    log::error!("[ETW Stderr]: {}", line);
                }
            }
        });

        let reader = BufReader::new(stdout);
        let db_conn = rusqlite::Connection::open(&db_path).ok();
        if let Some(conn) = &db_conn {
            let _ = conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
        }

        for line_result in reader.lines() {
            if let Ok(line) = line_result {
                if let Ok(log_val) = serde_json::from_str::<serde_json::Value>(&line) {
                    // Try to extract and save to database
                    if log_val["event_type"] == "FILE_CHANGE" {
                        if let Some(data) = log_val.get("data") {
                            let timestamp = data["timestamp"].as_str().unwrap_or("");
                            let pid = data["pid"].as_i64().unwrap_or(0) as i32;
                            let file_path = data["file_path"].as_str().unwrap_or("");
                            let operation_type = data["operation_type"].as_str().unwrap_or("");
                            let process_name = data["process_name"].as_str().unwrap_or("");
                            
                            let executable_path = data["executable_path"].as_str().unwrap_or("");
                            
                            if let Some(conn) = &db_conn {
                                // Insert app if not exists
                                let _ = conn.execute(
                                    "INSERT OR IGNORE INTO monitored_apps (pid, process_name, executable_path) VALUES (?1, ?2, ?3)",
                                    rusqlite::params![pid, process_name, executable_path],
                                );
                                // Update executable_path and last_seen
                                if !executable_path.is_empty() {
                                    let _ = conn.execute(
                                        "UPDATE monitored_apps SET executable_path = ?1, last_seen = CURRENT_TIMESTAMP WHERE pid = ?2",
                                        rusqlite::params![executable_path, pid],
                                    );
                                } else {
                                    let _ = conn.execute(
                                        "UPDATE monitored_apps SET last_seen = CURRENT_TIMESTAMP WHERE pid = ?1",
                                        rusqlite::params![pid],
                                    );
                                }
                                // Insert file event
                                let _ = conn.execute(
                                    "INSERT INTO file_events (timestamp, pid, file_path, operation_type) VALUES (?1, ?2, ?3, ?4)",
                                    rusqlite::params![timestamp, pid, file_path, operation_type],
                                );
                            }
                        }
                    }

                    let _ = app_handle_clone.emit("java-log", log_val);
                } else {
                    log::info!("[ETW Raw Stdout]: {}", line);
                }
            }
        }
        log::info!("ETW stdout reader finished.");
    });
}
