use aws_sdk_s3::Client;
use aws_sdk_s3::primitives::ByteStream;

pub async fn fetch_object(client: &Client) -> anyhow::Result<()> {
    let _resp = client
        .get_object()
        .bucket("static-assets")
        .key("logo.png")
        .send()
        .await?;
    Ok(())
}

pub async fn head_object(client: &Client) -> anyhow::Result<()> {
    let _resp = client
        .head_object()
        .bucket("static-assets")
        .key("logo.png")
        .send()
        .await?;
    Ok(())
}

pub async fn list_v2(client: &Client) -> anyhow::Result<()> {
    let _resp = client
        .list_objects_v2()
        .bucket("user-uploads")
        .prefix("inbox/")
        .send()
        .await?;
    Ok(())
}

pub async fn put_object(client: &Client, body: ByteStream) -> anyhow::Result<()> {
    let _resp = client
        .put_object()
        .bucket("user-uploads")
        .key("inbox/new.txt")
        .body(body)
        .send()
        .await?;
    Ok(())
}

pub async fn put_with_string_wrappers(client: &Client, body: ByteStream) -> anyhow::Result<()> {
    let _resp = client
        .put_object()
        .bucket("user-uploads".to_string())
        .key("rendered/index.html".to_owned())
        .body(body)
        .send()
        .await?;
    Ok(())
}

pub async fn copy_object(client: &Client) -> anyhow::Result<()> {
    let _resp = client
        .copy_object()
        .bucket("archive")
        .key("2026/snapshot.tar")
        .copy_source("user-uploads/inbox/new.txt")
        .send()
        .await?;
    Ok(())
}

pub async fn delete_object(client: &Client) -> anyhow::Result<()> {
    let _resp = client
        .delete_object()
        .bucket("user-uploads")
        .key("inbox/old.txt")
        .send()
        .await?;
    Ok(())
}

pub async fn delete_bucket(client: &Client) -> anyhow::Result<()> {
    let _resp = client
        .delete_bucket()
        .bucket("ephemeral-test-bucket")
        .send()
        .await?;
    Ok(())
}

pub async fn list_buckets(client: &Client) -> anyhow::Result<()> {
    let _resp = client.list_buckets().send().await?;
    Ok(())
}

pub async fn dynamic_key(client: &Client, bucket: &str, key: &str) -> anyhow::Result<()> {
    let _resp = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await?;
    Ok(())
}

pub async fn dynamic_key_two(client: &Client, k: String) -> anyhow::Result<()> {
    let _resp = client
        .get_object()
        .bucket("known-bucket")
        .key(k)
        .send()
        .await?;
    Ok(())
}

pub async fn multipart(client: &Client) -> anyhow::Result<()> {
    let _start = client
        .create_multipart_upload()
        .bucket("user-uploads")
        .key("large/movie.mp4")
        .send()
        .await?;
    Ok(())
}

pub async fn head_bucket(client: &Client) -> anyhow::Result<()> {
    let _resp = client
        .head_bucket()
        .bucket("static-assets")
        .send()
        .await?;
    Ok(())
}

/// Two S3 calls in one function with DIFFERENT bucket/key. Verifies
/// the chain walker doesn't conflate sibling calls' literals.
pub async fn two_calls_same_fn(client: &Client) -> anyhow::Result<()> {
    let _a = client
        .get_object()
        .bucket("alpha-bucket")
        .key("alpha.json")
        .send()
        .await?;
    let _b = client
        .delete_object()
        .bucket("beta-bucket")
        .key("beta.json")
        .send()
        .await?;
    Ok(())
}

/// `set_bucket`/`set_key` builder-with-Options setter form.
pub async fn set_form(client: &Client) -> anyhow::Result<()> {
    let _resp = client
        .head_object()
        .set_bucket(Some("gamma-bucket".to_string()))
        .set_key(Some("gamma.txt".to_string()))
        .send()
        .await?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = aws_config::load_from_env().await;
    let client = Client::new(&config);
    fetch_object(&client).await?;
    Ok(())
}
