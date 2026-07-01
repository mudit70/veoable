// Fixture for framework-reqwest.
//
// Covers:
//   - reqwest::get(URL) and reqwest::blocking::get(URL) — top-level
//   - <client>.get/post/put/delete/patch/head(URL) — method chain
//   - Receiver name heuristic (`client`, `api`, `http_client`,
//     `apiClient`, `self.client`)
//   - Static URL literal (urlLiteral set, exact)
//   - Dynamic URL via `format!(...)` (urlLiteral null, dynamic)
//   - Reference-of-string `&url` (urlLiteral null, dynamic)
//   - Negative: `.get(key)` on an unrelated receiver (`map.get(...)`)
//     and on a HashMap inside this file — must NOT emit
//   - Negative: file without any `use reqwest::*` import — method
//     calls in such a file are gated off
//
// Endpoint counts per assertion live in the test file.

use reqwest::Client;
use std::collections::HashMap;

pub async fn top_level_get() -> Result<(), Box<dyn std::error::Error>> {
    let _ = reqwest::get("https://api.example.com/users").await?;
    Ok(())
}

pub fn top_level_blocking_get() -> Result<(), Box<dyn std::error::Error>> {
    let _ = reqwest::blocking::get("https://api.example.com/health")?;
    Ok(())
}

pub async fn client_methods() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new();

    // GET — static literal
    let _ = client.get("https://api.example.com/users").send().await?;
    // POST — static literal
    let _ = client.post("https://api.example.com/users").send().await?;
    // PUT — dynamic, format!
    let id = 42;
    let _ = client.put(format!("https://api.example.com/users/{}", id)).send().await?;
    // DELETE — &url (dynamic)
    let url = String::from("https://api.example.com/users/1");
    let _ = client.delete(&url).send().await?;
    // PATCH — static literal
    let _ = client.patch("https://api.example.com/users/1").send().await?;
    // HEAD — static literal
    let _ = client.head("https://api.example.com/users").send().await?;

    Ok(())
}

pub async fn aliased_client_names() -> Result<(), Box<dyn std::error::Error>> {
    let api = Client::new();
    let _ = api.get("https://api.example.com/items").send().await?;

    let http_client = Client::new();
    let _ = http_client.post("https://api.example.com/items").send().await?;

    Ok(())
}

pub struct ApiWrapper {
    client: Client,
}

impl ApiWrapper {
    pub async fn fetch(&self) -> Result<(), Box<dyn std::error::Error>> {
        // `self.client.get(...)` — RECEIVER_RE handles `self.client`.
        let _ = self.client.get("https://api.example.com/wrapped").send().await?;
        Ok(())
    }
}

pub fn unrelated_get_must_not_emit() {
    // HashMap.get(key) is NOT an HTTP call. RECEIVER_RE requires the
    // receiver name to contain client/http/api/reqwest, so `map` is
    // rejected. (Belt-and-braces: we also check the method's first
    // arg is a string; HashMap::get takes a borrow of K which here is
    // a string-typed reference, so the literal-string filter alone
    // wouldn't save us.)
    let mut map: HashMap<String, i32> = HashMap::new();
    map.insert("foo".to_string(), 1);
    let _ = map.get("foo");
}
