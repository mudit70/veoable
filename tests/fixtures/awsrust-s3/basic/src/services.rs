use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_sns::Client as SnsClient;
use aws_sdk_sqs::Client as SqsClient;

// ── DynamoDB ──────────────────────────────────────────────────────

pub async fn get_user(client: &DynamoClient) -> Result<(), Box<dyn std::error::Error>> {
    // GET → dynamodb://users/
    client.get_item().table_name("users").send().await?;
    Ok(())
}

pub async fn put_user(client: &DynamoClient) -> Result<(), Box<dyn std::error::Error>> {
    // PUT → dynamodb://users/
    client.put_item().table_name("users").send().await?;
    Ok(())
}

pub async fn query_orders(client: &DynamoClient) -> Result<(), Box<dyn std::error::Error>> {
    // GET → dynamodb://orders/
    client.query().table_name("orders").send().await?;
    Ok(())
}

pub async fn delete_session(client: &DynamoClient) -> Result<(), Box<dyn std::error::Error>> {
    // DELETE → dynamodb://sessions/
    client.delete_item().table_name("sessions").send().await?;
    Ok(())
}

pub async fn update_profile(client: &DynamoClient) -> Result<(), Box<dyn std::error::Error>> {
    // PATCH → dynamodb://users/
    client.update_item().table_name("users").send().await?;
    Ok(())
}

pub async fn dynamic_table(client: &DynamoClient, name: &str) -> Result<(), Box<dyn std::error::Error>> {
    // GET (dynamic) → null URL
    client.get_item().table_name(name).send().await?;
    Ok(())
}

// ── SQS ───────────────────────────────────────────────────────────

pub async fn send_order(client: &SqsClient) -> Result<(), Box<dyn std::error::Error>> {
    // JOB → sqs:order-events
    client
        .send_message()
        .queue_url("https://sqs.us-east-1.amazonaws.com/123456789012/order-events")
        .message_body("payload")
        .send()
        .await?;
    Ok(())
}

pub async fn receive_order(client: &SqsClient) -> Result<(), Box<dyn std::error::Error>> {
    // JOB → sqs:order-events
    client
        .receive_message()
        .queue_url("https://sqs.us-east-1.amazonaws.com/123456789012/order-events")
        .send()
        .await?;
    Ok(())
}

pub async fn send_dynamic(client: &SqsClient, queue: &str) -> Result<(), Box<dyn std::error::Error>> {
    // JOB (dynamic) → null
    client.send_message().queue_url(queue).send().await?;
    Ok(())
}

// ── SNS ───────────────────────────────────────────────────────────

pub async fn publish_alert(client: &SnsClient, msg: &str) -> Result<(), Box<dyn std::error::Error>> {
    // JOB → sns:critical-alerts
    client
        .publish()
        .topic_arn("arn:aws:sns:us-east-1:123456789012:critical-alerts")
        .message(msg)
        .send()
        .await?;
    Ok(())
}

pub async fn publish_dynamic(client: &SnsClient, arn: &str, msg: &str) -> Result<(), Box<dyn std::error::Error>> {
    // JOB (dynamic) → null
    client.publish().topic_arn(arn).message(msg).send().await?;
    Ok(())
}

// ── Lambda ────────────────────────────────────────────────────────

pub async fn invoke_processor(client: &LambdaClient) -> Result<(), Box<dyn std::error::Error>> {
    // POST → lambda:process-order
    client.invoke().function_name("process-order").send().await?;
    Ok(())
}

pub async fn invoke_dynamic(client: &LambdaClient, name: &str) -> Result<(), Box<dyn std::error::Error>> {
    // POST (dynamic) → null
    client.invoke().function_name(name).send().await?;
    Ok(())
}
