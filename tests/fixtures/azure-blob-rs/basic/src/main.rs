use azure_storage_blobs::prelude::*;

pub async fn fetch_blob(svc: &BlobServiceClient) -> azure_core::Result<()> {
    // GET → azure://static-assets/logo.png
    let _ = svc.container_client("static-assets").blob_client("logo.png").get().await?;
    Ok(())
}

pub async fn upload_blob(svc: &BlobServiceClient, data: Vec<u8>) -> azure_core::Result<()> {
    // PUT → azure://user-uploads/inbox/new.txt
    let _ = svc.container_client("user-uploads").blob_client("inbox/new.txt").put_block_blob(data).await?;
    Ok(())
}

pub async fn delete_blob(svc: &BlobServiceClient) -> azure_core::Result<()> {
    // DELETE → azure://archive/2026/snapshot.tar
    let _ = svc.container_client("archive").blob_client("2026/snapshot.tar").delete().await?;
    Ok(())
}

pub async fn head_blob(svc: &BlobServiceClient) -> azure_core::Result<()> {
    // GET (exists) → azure://static-assets/logo.png
    let _ = svc.container_client("static-assets").blob_client("logo.png").exists().await?;
    Ok(())
}

pub async fn set_blob_metadata(svc: &BlobServiceClient) -> azure_core::Result<()> {
    // PUT (set_metadata) → azure://configs/app.json
    let _ = svc.container_client("configs").blob_client("app.json").set_metadata(Default::default()).await?;
    Ok(())
}

pub async fn list_files_in_container(svc: &BlobServiceClient) -> azure_core::Result<()> {
    // GET → azure://static-assets/ (container scope)
    let _ = svc.container_client("static-assets").list_blobs().await;
    Ok(())
}

pub async fn delete_container(svc: &BlobServiceClient) -> azure_core::Result<()> {
    // DELETE → azure://temp-container/ (container scope)
    let _ = svc.container_client("temp-container").delete().await?;
    Ok(())
}

pub async fn create_container(svc: &BlobServiceClient) -> azure_core::Result<()> {
    // PUT (create) → azure://new-container/ (container scope)
    let _ = svc.container_client("new-container").create().await?;
    Ok(())
}

pub async fn append_block_to_blob(svc: &BlobServiceClient, data: Vec<u8>) -> azure_core::Result<()> {
    // PUT → azure://logs/system.log
    let _ = svc.container_client("logs").blob_client("system.log").append_block(data).await?;
    Ok(())
}

pub async fn raw_string_blob(svc: &BlobServiceClient) -> azure_core::Result<()> {
    // GET → azure://raw-container/raw-key (raw string literal)
    let _ = svc.container_client(r"raw-container").blob_client(r"raw-key").get().await?;
    Ok(())
}

pub async fn dynamic_container(svc: &BlobServiceClient, name: &str) -> azure_core::Result<()> {
    // GET (dynamic) → null URL
    let _ = svc.container_client(name).blob_client("logo.png").get().await?;
    Ok(())
}

pub async fn dynamic_blob(svc: &BlobServiceClient, key: &str) -> azure_core::Result<()> {
    // GET (literal container, dynamic blob) → azure://static-assets/ (dynamic)
    let _ = svc.container_client("static-assets").blob_client(key).get().await?;
    Ok(())
}
