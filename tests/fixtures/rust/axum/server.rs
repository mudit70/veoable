use axum::{Router, routing::{get, post, delete}};

async fn list_users() -> String { String::new() }
async fn get_user() -> String { String::new() }
async fn create_user() -> String { String::new() }
async fn delete_user() -> String { String::new() }

fn app() -> Router {
    Router::new()
        .route("/users", get(list_users).post(create_user))
        .route("/users/:id", get(get_user).delete(delete_user))
}
