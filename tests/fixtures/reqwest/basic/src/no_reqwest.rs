// Negative fixture: file with NO `use reqwest::*` import.
// Method-call shape is per-file gated — `client.get(...)` here
// must NOT emit a ClientSideAPICaller because the file doesn't
// import reqwest.

pub fn looks_like_reqwest_but_isnt() {
    struct PretendClient;
    impl PretendClient {
        fn get(&self, _url: &str) -> &'static str { "" }
    }
    let client = PretendClient;
    let _ = client.get("https://api.example.com/nope");
}
