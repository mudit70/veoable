struct FakeBlob;
struct FakeContainer;
struct FakeSvc;

impl FakeBlob {
    pub async fn get(&self) {}
    pub async fn delete(&self) {}
}
impl FakeContainer {
    pub fn blob_client(&self, _k: &str) -> FakeBlob { FakeBlob }
}
impl FakeSvc {
    pub fn container_client(&self, _c: &str) -> FakeContainer { FakeContainer }
}

pub async fn local_fetch() {
    let svc = FakeSvc;
    svc.container_client("nope").blob_client("nope").get().await;
    svc.container_client("nope").blob_client("nope").delete().await;
}
