use serde::{Deserialize, Serialize};

const SERVICE: &str = "app.subtrack.desktop";
const ACCOUNT: &str = "auth-refresh-credential";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSession {
    refresh_credential: String,
    subject: String,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| "secure_storage_unavailable".into())
}

#[tauri::command]
fn write_session_secret(session: PersistedSession) -> Result<(), String> {
    let value = serde_json::to_string(&session).map_err(|_| "session_encode_failed")?;
    entry()?.set_password(&value).map_err(|_| "session_save_failed".into())
}

#[tauri::command]
fn read_session_secret() -> Result<Option<PersistedSession>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|_| "session_decode_failed".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("session_load_failed".into()),
    }
}

#[tauri::command]
fn clear_session_secret() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("session_remove_failed".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            write_session_secret,
            read_session_secret,
            clear_session_secret
        ])
        .run(tauri::generate_context!())
        .expect("tauri runtime failed");
}
