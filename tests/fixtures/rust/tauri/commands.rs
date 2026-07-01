use tauri;

#[tauri::command]
async fn get_users() -> Vec<String> {
    vec!["Alice".into(), "Bob".into()]
}

#[tauri::command]
async fn create_user(name: String) -> String {
    format!("Created {}", name)
}

#[tauri::command]
async fn delete_user(id: u32) -> bool {
    true
}
