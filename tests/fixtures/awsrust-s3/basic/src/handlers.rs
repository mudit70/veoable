// Identifier-arg call sites — fluent builder takes `&state.X`,
// `state.X`, `&self.X` instead of a string literal. Each one
// should resolve via the struct-field map.

use aws_sdk_dynamodb::types::AttributeValue;

use crate::state::AppState;

pub async fn query_by_symbol(state: &AppState, symbol: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    state
        .dynamo
        .query()
        .table_name(&state.orders_table)
        .index_name("SymbolIndex")
        .key_condition_expression("#sym = :sym")
        .expression_attribute_values(":sym", AttributeValue::S(symbol.to_string()))
        .send()
        .await?;
    Ok(())
}

pub async fn cancel_order(state: &AppState, id: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    state
        .dynamo
        .update_item()
        .table_name(&state.orders_table)
        .key("id", AttributeValue::S(id.to_string()))
        .send()
        .await?;
    Ok(())
}

pub async fn enqueue_order(state: &AppState, payload: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    state
        .sqs
        .send_message()
        .queue_url(&state.orders_queue_url)
        .message_body(payload.to_string())
        .send()
        .await?;
    Ok(())
}

pub async fn read_session(state: &AppState, id: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Uses the unwrap_or fallback path
    state
        .dynamo
        .get_item()
        .table_name(state.sessions_table.clone())
        .key("id", AttributeValue::S(id.to_string()))
        .send()
        .await?;
    Ok(())
}

// Bare-literal default field — verify the bare-literal pattern wins
// (no env var, just `bucket_name: "uploads".to_string()`)
pub async fn upload_to_bucket(state: &AppState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    state
        .dynamo
        .scan()
        .table_name(&state.bucket_name)
        .send()
        .await?;
    Ok(())
}
