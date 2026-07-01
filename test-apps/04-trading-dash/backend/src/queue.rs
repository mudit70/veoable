use crate::orders::Order;
use crate::state::AppState;

pub async fn enqueue_order(
    state: &AppState,
    order: &Order,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let body = serde_json::to_string(order)?;
    state
        .sqs
        .send_message()
        .queue_url(&state.orders_queue_url)
        .message_body(body)
        .send()
        .await?;
    Ok(())
}
