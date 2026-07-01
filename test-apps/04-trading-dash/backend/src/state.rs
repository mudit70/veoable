use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_sqs::Client as SqsClient;

#[derive(Clone)]
pub struct AppState {
    pub dynamo: DynamoClient,
    pub sqs: SqsClient,
    pub orders_queue_url: String,
    pub orders_table: String,
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
            orders_table: std::env::var("ORDERS_TABLE").unwrap_or_else(|_| "Orders".into()),
        }
    }
}
