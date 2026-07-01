use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client as DynamoClient;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct IncomingOrder {
    id: String,
    symbol: String,
    side: String,
    quantity: i64,
    #[serde(rename = "priceCents")]
    price_cents: i64,
    status: String,
    #[serde(rename = "placedAt")]
    placed_at: String,
}

pub async fn handle_message(
    dynamo: &DynamoClient,
    table: &str,
    body: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut order: IncomingOrder = serde_json::from_str(body)?;
    // Naive fill: always mark filled.
    order.status = "filled".into();

    dynamo
        .put_item()
        .table_name(table)
        .item("id", AttributeValue::S(order.id))
        .item("symbol", AttributeValue::S(order.symbol))
        .item("side", AttributeValue::S(order.side))
        .item("quantity", AttributeValue::N(order.quantity.to_string()))
        .item("priceCents", AttributeValue::N(order.price_cents.to_string()))
        .item("status", AttributeValue::S(order.status))
        .item("placedAt", AttributeValue::S(order.placed_at))
        .send()
        .await?;

    Ok(())
}
