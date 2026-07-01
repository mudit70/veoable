use axum::{Router, routing::{get, post, put, delete}, Json};

async fn list_users() -> Json<Vec<String>> {
    Json(vec!["Alice".into(), "Bob".into()])
}

async fn get_user() -> Json<String> {
    Json("user".into())
}

async fn create_user() -> Json<String> {
    Json("created".into())
}

async fn delete_user() -> Json<String> {
    Json("deleted".into())
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/users", get(list_users).post(create_user))
        .route("/users/:id", get(get_user).delete(delete_user));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
