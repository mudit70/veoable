// Fixture for axum handler resolution.
//
// Exercises:
//   - bare free-function handler:           `get(list_orders)`
//   - scoped-path handler:                  `get(orders::list)`
//   - chained method router:                `get(a).post(b).delete(c)`
//   - inline closure handler:               `get(|| async { ... })`
//   - ambiguous name handler:               two `same` functions in
//                                            different modules — must
//                                            resolve to null

use axum::{Router, routing::{delete, get, post}};

mod orders {
    pub async fn list() -> String { String::new() }
}

mod portfolio {
    pub async fn compute() -> String { String::new() }
}

// Two functions named `same` to trigger the ambiguous-name path.
mod amb_a {
    pub async fn same() -> String { String::new() }
}
mod amb_b {
    pub async fn same() -> String { String::new() }
}

async fn list_orders() -> String { String::new() }
async fn place_order() -> String { String::new() }
async fn cancel_order() -> String { String::new() }
async fn get_portfolio() -> String { String::new() }

fn build_router() -> Router {
    Router::new()
        // Chained method router with three handlers.
        .route(
            "/api/orders",
            get(list_orders).post(place_order).delete(cancel_order),
        )
        // Scoped-path handler.
        .route("/api/orders/list", get(orders::list))
        // Plain bare-identifier handler.
        .route("/api/portfolio", get(get_portfolio))
        // Inline closure handler — must resolve to NULL.
        .route("/api/health", get(|| async { "ok" }))
        // Ambiguous-name handler — must resolve to NULL even though
        // the scoped path disambiguates statically (the resolver
        // lookups by last segment only).
        .route("/api/ambig", get(amb_a::same))
}
