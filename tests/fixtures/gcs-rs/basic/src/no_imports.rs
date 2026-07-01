struct FakeClient;
struct FakeRequest {
    bucket: String,
    object: String,
}

impl FakeClient {
    pub async fn download_object(&self, _req: &FakeRequest) -> Vec<u8> {
        Vec::new()
    }
}

pub async fn local_fetch() {
    let c = FakeClient;
    let _ = c
        .download_object(&FakeRequest {
            bucket: "nope".to_string(),
            object: "nope".to_string(),
        })
        .await;
}
