// Worker-style let-bound local URLs. The resolver picks up the
// `let X = env::var(...).unwrap_or_else(|_| "...".into())` shape
// so `&X` at the call site resolves like a struct-field reference.

use aws_sdk_sqs::Client as SqsClient;

pub async fn pump(sqs: &SqsClient) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let notif_queue_url = std::env::var("NOTIF_QUEUE_URL")
        .unwrap_or_else(|_| "https://sqs.us-east-1.amazonaws.com/123456789012/notifications".into());

    sqs.send_message()
        .queue_url(&notif_queue_url)
        .message_body("hello".to_string())
        .send()
        .await?;
    Ok(())
}
