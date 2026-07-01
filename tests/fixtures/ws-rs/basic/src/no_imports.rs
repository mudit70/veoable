// File without tungstenite use — must produce zero emits.

pub struct FakeBus;

impl FakeBus {
    pub async fn accept_async(&self) {}
    pub async fn connect_async(&self, _url: &str) {}
}

pub async fn local(b: &FakeBus) {
    b.accept_async().await;
    b.connect_async("ws://nope").await;
}
