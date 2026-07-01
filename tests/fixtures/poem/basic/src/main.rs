use poem::{get, post, delete, put, Route, Server, listener::TcpListener};

async fn hello() -> &'static str { "hello" }
async fn list_users() -> &'static str { "users" }
async fn create_user() -> &'static str { "created" }
async fn update_user() -> &'static str { "updated" }
async fn delete_user() -> &'static str { "deleted" }
async fn health() -> &'static str { "ok" }

#[tokio::main]
async fn main() {
    let app = Route::new()
        .at("/hello", get(hello))
        .at("/users", get(list_users).post(create_user))
        .at("/users/:id", put(update_user).delete(delete_user))
        .at("/health", get(health));

    let _ = Server::new(TcpListener::bind("0.0.0.0:8080")).run(app).await;
}
