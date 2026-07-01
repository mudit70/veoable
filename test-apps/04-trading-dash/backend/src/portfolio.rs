use aws_sdk_dynamodb::types::AttributeValue;
use serde::Serialize;
use std::collections::HashMap;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct PortfolioPosition {
    pub symbol: String,
    pub quantity: i64,
    #[serde(rename = "avgCostCents")]
    pub avg_cost_cents: i64,
}

pub async fn compute(
    state: &AppState,
) -> Result<Vec<PortfolioPosition>, Box<dyn std::error::Error + Send + Sync>> {
    // Scan all filled orders, group by symbol.
    let resp = state
        .dynamo
        .scan()
        .table_name(&state.orders_table)
        .filter_expression("#s = :s")
        .expression_attribute_names("#s", "status")
        .expression_attribute_values(":s", AttributeValue::S("filled".into()))
        .send()
        .await?;

    let mut acc: HashMap<String, (i64, i64)> = HashMap::new();
    for item in resp.items.unwrap_or_default() {
        let symbol = item.get("symbol").and_then(|v| v.as_s().ok()).cloned().unwrap_or_default();
        let side = item.get("side").and_then(|v| v.as_s().ok()).cloned().unwrap_or_default();
        let qty: i64 = item
            .get("quantity")
            .and_then(|v| v.as_n().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let price: i64 = item
            .get("priceCents")
            .and_then(|v| v.as_n().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let entry = acc.entry(symbol).or_insert((0, 0));
        let signed_qty = if side == "buy" { qty } else { -qty };
        entry.0 += signed_qty;
        entry.1 += signed_qty * price;
    }

    Ok(acc
        .into_iter()
        .map(|(symbol, (quantity, cost))| {
            let avg = if quantity == 0 { 0 } else { cost / quantity };
            PortfolioPosition { symbol, quantity, avg_cost_cents: avg }
        })
        .collect())
}
