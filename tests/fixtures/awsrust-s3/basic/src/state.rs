// #523 item 1 fixture — struct-field defaults for state-carrying
// services. The visitor's project-load pass scans this file for
// field default literals so identifier args at the call site can
// be resolved.

use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_sqs::Client as SqsClient;

#[derive(Clone)]
pub struct AppState {
    pub dynamo: DynamoClient,
    pub sqs: SqsClient,
    // env-with-unwrap_or_else fallback
    pub orders_queue_url: String,
    // env-with-unwrap_or_else fallback
    pub orders_table: String,
    // env-with-unwrap_or fallback
    pub sessions_table: String,
    // bare wrapped literal
    pub bucket_name: String,
}

impl AppState {
    pub async fn new() -> Self {
        let cfg = aws_config::load_from_env().await;
        let dynamo = DynamoClient::new(&cfg);
        let sqs = SqsClient::new(&cfg);
        Self {
            dynamo,
            sqs,
            orders_queue_url: std::env::var("ORDERS_QUEUE_URL")
                .unwrap_or_else(|_| "https://sqs.us-east-1.amazonaws.com/123456789012/orders-incoming".into()),
            orders_table: std::env::var("ORDERS_TABLE")
                .unwrap_or_else(|_| "Orders".into()),
            sessions_table: std::env::var("SESSIONS_TABLE")
                .unwrap_or("Sessions".to_string()),
            bucket_name: "uploads".to_string(),
        }
    }
}
