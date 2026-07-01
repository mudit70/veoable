use aws_sdk_dynamodb::types::AttributeValue;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: String,
    pub symbol: String,
    pub side: String,
    pub quantity: i64,
    #[serde(rename = "priceCents")]
    pub price_cents: i64,
    pub status: String,
    #[serde(rename = "placedAt")]
    pub placed_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewOrderInput {
    pub symbol: String,
    pub side: String,
    pub quantity: i64,
    #[serde(rename = "priceCents")]
    pub price_cents: i64,
}

impl Order {
    pub fn new(input: NewOrderInput) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            symbol: input.symbol,
            side: input.side,
            quantity: input.quantity,
            price_cents: input.price_cents,
            status: "pending".into(),
            placed_at: Utc::now().to_rfc3339(),
        }
    }
}

pub async fn query_by_symbol(
    state: &AppState,
    symbol: &str,
) -> Result<Vec<Order>, Box<dyn std::error::Error + Send + Sync>> {
    let resp = state
        .dynamo
        .query()
        .table_name(&state.orders_table)
        .index_name("SymbolIndex")
        .key_condition_expression("#sym = :sym")
        .expression_attribute_names("#sym", "symbol")
        .expression_attribute_values(":sym", AttributeValue::S(symbol.to_string()))
        .send()
        .await?;

    let items = resp.items.unwrap_or_default();
    let mut orders = Vec::with_capacity(items.len());
    for item in items {
        orders.push(decode_order(&item));
    }
    Ok(orders)
}

pub async fn cancel(
    state: &AppState,
    id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    state
        .dynamo
        .update_item()
        .table_name(&state.orders_table)
        .key("id", AttributeValue::S(id.to_string()))
        .update_expression("SET #s = :s")
        .expression_attribute_names("#s", "status")
        .expression_attribute_values(":s", AttributeValue::S("cancelled".to_string()))
        .send()
        .await?;
    Ok(())
}

fn decode_order(item: &std::collections::HashMap<String, AttributeValue>) -> Order {
    let s = |k: &str| -> String {
        item.get(k).and_then(|v| v.as_s().ok()).cloned().unwrap_or_default()
    };
    let n = |k: &str| -> i64 {
        item.get(k)
            .and_then(|v| v.as_n().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or_default()
    };
    Order {
        id: s("id"),
        symbol: s("symbol"),
        side: s("side"),
        quantity: n("quantity"),
        price_cents: n("priceCents"),
        status: s("status"),
        placed_at: s("placedAt"),
    }
}
