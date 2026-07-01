mod handler;

use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_sqs::Client as SqsClient;
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let cfg = aws_config::load_from_env().await;
    let sqs = SqsClient::new(&cfg);
    let dynamo = DynamoClient::new(&cfg);

    let queue_url = std::env::var("ORDERS_QUEUE_URL")
        .unwrap_or_else(|_| "https://sqs.us-east-1.amazonaws.com/123456789012/orders-incoming".into());
    let table = std::env::var("ORDERS_TABLE").unwrap_or_else(|_| "Orders".into());

    loop {
        let out = sqs
            .receive_message()
            .queue_url(&queue_url)
            .max_number_of_messages(10)
            .wait_time_seconds(10)
            .send()
            .await?;

        for msg in out.messages.unwrap_or_default() {
            if let Some(body) = msg.body.as_deref() {
                if let Err(err) = handler::handle_message(&dynamo, &table, body).await {
                    tracing::error!("handle: {err}");
                    continue;
                }
                if let Some(rh) = msg.receipt_handle.as_deref() {
                    let _ = sqs
                        .delete_message()
                        .queue_url(&queue_url)
                        .receipt_handle(rh)
                        .send()
                        .await;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
