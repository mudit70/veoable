use google_cloud_storage::client::Client;
use google_cloud_storage::http::objects::delete::DeleteObjectRequest;
use google_cloud_storage::http::objects::download::Range;
use google_cloud_storage::http::objects::get::GetObjectRequest;
use google_cloud_storage::http::objects::list::ListObjectsRequest;
use google_cloud_storage::http::objects::upload::{Media, UploadObjectRequest, UploadType};
use google_cloud_storage::http::buckets::delete::DeleteBucketRequest;

pub async fn fetch_object(client: &Client) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // GET → gs://static-assets/logo.png
    let data = client
        .download_object(
            &GetObjectRequest {
                bucket: "static-assets".to_string(),
                object: "logo.png".to_string(),
                ..Default::default()
            },
            &Range::default(),
        )
        .await?;
    Ok(data)
}

pub async fn upload_object(client: &Client, body: Vec<u8>) -> Result<(), Box<dyn std::error::Error>> {
    // PUT → gs://user-uploads/inbox/new.txt
    let upload_type = UploadType::Simple(Media::new("inbox/new.txt"));
    let _ = client
        .upload_object(
            &UploadObjectRequest {
                bucket: "user-uploads".to_string(),
                ..Default::default()
            },
            body,
            &upload_type,
        )
        .await?;
    Ok(())
}

pub async fn delete_object(client: &Client) -> Result<(), Box<dyn std::error::Error>> {
    // DELETE → gs://archive/2026/snapshot.tar
    let _ = client
        .delete_object(&DeleteObjectRequest {
            bucket: "archive".to_string(),
            object: "2026/snapshot.tar".to_string(),
            ..Default::default()
        })
        .await?;
    Ok(())
}

pub async fn list_in_bucket(client: &Client) -> Result<(), Box<dyn std::error::Error>> {
    // GET → gs://static-assets/ (bucket scope)
    let _ = client
        .list_objects(&ListObjectsRequest {
            bucket: "static-assets".to_string(),
            ..Default::default()
        })
        .await?;
    Ok(())
}

pub async fn delete_bucket(client: &Client) -> Result<(), Box<dyn std::error::Error>> {
    // DELETE → gs://temp-bucket/ (bucket scope)
    let _ = client
        .delete_bucket(&DeleteBucketRequest {
            bucket: "temp-bucket".to_string(),
            ..Default::default()
        })
        .await?;
    Ok(())
}

pub async fn string_from_form(client: &Client) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // GET → gs://configs/app.json (via String::from)
    let data = client
        .download_object(
            &GetObjectRequest {
                bucket: String::from("configs"),
                object: String::from("app.json"),
                ..Default::default()
            },
            &Range::default(),
        )
        .await?;
    Ok(data)
}

pub async fn dynamic_bucket(
    client: &Client,
    bucket_name: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // GET (dynamic) → null URL
    let data = client
        .download_object(
            &GetObjectRequest {
                bucket: bucket_name.to_string(),
                object: "logo.png".to_string(),
                ..Default::default()
            },
            &Range::default(),
        )
        .await?;
    Ok(data)
}

pub async fn dynamic_key(
    client: &Client,
    key: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // GET (literal bucket, dynamic key) → gs://static-assets/ (dynamic)
    let data = client
        .download_object(
            &GetObjectRequest {
                bucket: "static-assets".to_string(),
                object: key.to_string(),
                ..Default::default()
            },
            &Range::default(),
        )
        .await?;
    Ok(data)
}
