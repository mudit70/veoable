struct Fake;

impl Fake {
    pub async fn basic_publish(&self, _e: &str, _r: &str) {}
    pub async fn basic_consume(&self, _q: &str, _t: &str) {}
}

pub async fn local() {
    let f = Fake;
    f.basic_publish("nope", "nope").await;
    f.basic_consume("nope", "nope").await;
}
