mod handlers;
mod models;
mod service;

use actix_web::{web, App, HttpServer};

pub async fn health_check() -> &'static str {
    "OK"
}

fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api")
            .route("/health", web::get().to(health_check))
    );
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new().configure(configure_routes)
    })
    .bind("127.0.0.1:8080")?
    .run()
    .await
}
