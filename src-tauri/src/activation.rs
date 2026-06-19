use reqwest::Client;
use serde_json::Value;
use tauri::AppHandle;
use tauri::Manager;
use std::fs;
use std::path::PathBuf;

fn get_activation_file(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap().join("activation.key")
}

fn get_supabase_url() -> String {
    let p1 = "https://YOUR_";
    let p2 = "SUPABASE_PROJECT";
    let p3 = ".supabase.co";
    format!("{}{}{}", p1, p2, p3)
}

fn get_supabase_key() -> String {
    let p1 = "sb_publishable_";
    let p2 = "YOUR_SUPABASE_";
    let p3 = "KEY_HERE";
    format!("{}{}{}", p1, p2, p3)
}

#[tauri::command]
pub fn get_machine_id() -> String {
    machine_uid::get().unwrap_or_else(|_| "unknown_machine_id".to_string())
}

#[tauri::command]
pub async fn verify_activation_code(
    app: AppHandle,
    code: String,
) -> Result<bool, String> {
    let client = Client::new();
    let supabase_url = get_supabase_url();
    let supabase_key = get_supabase_key();
    let act_file = get_activation_file(&app);

    // Call Supabase REST API
    let endpoint = format!("{}/rest/v1/activation_codes?code=eq.{}&select=*", supabase_url, code);
    
    let res = client.get(&endpoint)
        .header("apikey", &supabase_key)
        .header("Authorization", format!("Bearer {}", supabase_key))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Supabase API error: {}", res.status()));
    }

    let records: Vec<Value> = res.json().await.map_err(|e| e.to_string())?;
    
    if records.is_empty() {
        return Ok(false); // Invalid code
    }

    let record = &records[0];
    
    // Check if is_active is true
    if let Some(is_active) = record.get("is_active").and_then(|v| v.as_bool()) {
        if !is_active {
            return Ok(false); // Code is disabled
        }
    } else {
        return Ok(false);
    }

    // Verification passed, save to local cache
    let _ = fs::write(&act_file, &code);

    Ok(true)
}

#[tauri::command]
pub async fn is_activated(app: AppHandle) -> Result<bool, String> {
    let act_file = get_activation_file(&app);
    let cached_code = match fs::read_to_string(&act_file) {
        Ok(code) => code.trim().to_string(),
        Err(_) => return Ok(false),
    };
    
    if cached_code.is_empty() {
        return Ok(false);
    }
    
    // Call Supabase with the cached code
    let res = verify_activation_code(app.clone(), cached_code.clone()).await;
    match res {
        Ok(true) => Ok(true),
        _ => {
            // If it failed verification (e.g. key no longer active), delete the local cache
            let _ = fs::remove_file(&act_file);
            Ok(false)
        }
    }
}
