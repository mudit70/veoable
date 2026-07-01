use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::orders::{self, NewOrderInput, Order};
use crate::portfolio::{self, PortfolioPosition};
use crate::queue;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ListQuery {
    pub symbol: Option<String>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/orders", get(list_orders).post(place_order))
        .route("/api/orders/:id", delete(cancel_order))
        .route("/api/portfolio", get(get_portfolio))
        .route("/api/health", get(|| async { "ok" }))
        .with_state(state)
}

async fn list_orders(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<Order>>, StatusCode> {
    let symbol = q.symbol.unwrap_or_default();
    let orders = orders::query_by_symbol(&state, &symbol)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(orders))
}

async fn place_order(
    State(state): State<AppState>,
    Json(input): Json<NewOrderInput>,
) -> Result<Json<Order>, StatusCode> {
    let order = Order::new(input);
    queue::enqueue_order(&state, &order)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(order))
}

async fn cancel_order(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    orders::cancel(&state, &id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_portfolio(
    State(state): State<AppState>,
) -> Result<Json<Vec<PortfolioPosition>>, StatusCode> {
    let pos = portfolio::compute(&state)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(pos))
}
