// File without aws_sdk_s3 use — must produce zero emits.

pub struct FakeClient;

impl FakeClient {
    pub fn put_object(&self) -> &Self { self }
    pub fn bucket(&self, _b: &str) -> &Self { self }
    pub fn key(&self, _k: &str) -> &Self { self }
    pub async fn send(&self) -> anyhow::Result<()> { Ok(()) }
}

pub async fn local(c: &FakeClient) -> anyhow::Result<()> {
    c.put_object().bucket("nope").key("nope").send().await?;
    Ok(())
}
