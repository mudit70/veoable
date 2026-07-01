use rocket::{get, post, delete};

#[get("/items")]
fn list_items() -> &'static str { "[]" }

#[get("/items/<id>")]
fn get_item(id: u32) -> String { format!("{}", id) }

#[post("/items")]
fn create_item() -> &'static str { "created" }

#[delete("/items/<id>")]
fn delete_item(id: u32) -> &'static str { "deleted" }

// M2 fix: query param stripping test
#[get("/search?<query>&<limit>")]
fn search(query: String, limit: Option<u32>) -> String { query }

// M2 fix: catch-all route test
#[get("/files/<path..>")]
fn serve_file(path: std::path::PathBuf) -> &'static str { "file" }
