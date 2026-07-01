use axum::{Router, routing::get};

async fn list_users() -> String { String::new() }
async fn get_user() -> String { String::new() }
async fn list_v1() -> String { String::new() }
async fn health() -> String { String::new() }

fn build() -> Router {
    let api = Router::new()
        .route("/users", get(list_users))
        .route("/users/:id", get(get_user));

    let v1 = Router::new()
        .route("/profile", get(list_v1));

    let app = Router::new()
        .nest("/api", api)
        .nest("/api/v1", v1)
        .route("/health", get(health));

    app
}
