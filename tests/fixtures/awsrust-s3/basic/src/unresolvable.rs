// Negative tests — args that the resolver should not lift.

use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client as DynamoClient;

fn get_table_name() -> String {
    "Whatever".to_string()
}

// Function-call result — must NOT resolve.
pub async fn dynamic_from_fn(dynamo: &DynamoClient) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    dynamo
        .scan()
        .table_name(get_table_name())
        .send()
        .await?;
    Ok(())
}

// Conditional expression — must NOT resolve.
pub async fn dynamic_from_cond(dynamo: &DynamoClient, primary: bool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    dynamo
        .scan()
        .table_name(if primary { "A".to_string() } else { "B".to_string() })
        .send()
        .await?;
    Ok(())
}
