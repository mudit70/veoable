// Two `let table = "..."` bindings in different functions.
// The resolver's map is keyed by name only, so they collide —
// last-write-wins, both call sites resolve to the same value.

use aws_sdk_dynamodb::Client as DynamoClient;

pub async fn read_users(dynamo: &DynamoClient) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let coll_table = "Users".to_string();
    dynamo.scan().table_name(&coll_table).send().await?;
    Ok(())
}

pub async fn read_orders(dynamo: &DynamoClient) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let coll_table = "Orders".to_string();
    dynamo.scan().table_name(&coll_table).send().await?;
    Ok(())
}
