use actix_web::{get, post, put, delete, web, App, HttpServer, HttpResponse};

#[get("/users")]
async fn list_users() -> HttpResponse {
    HttpResponse::Ok().json(vec!["Alice", "Bob"])
}

#[get("/users/{id}")]
async fn get_user(id: web::Path<u32>) -> HttpResponse {
    HttpResponse::Ok().json(format!("user {}", id))
}

#[post("/users")]
async fn create_user() -> HttpResponse {
    HttpResponse::Created().finish()
}

#[put("/users/{id}")]
async fn update_user(id: web::Path<u32>) -> HttpResponse {
    HttpResponse::Ok().finish()
}

#[delete("/users/{id}")]
async fn delete_user(id: web::Path<u32>) -> HttpResponse {
    HttpResponse::NoContent().finish()
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| App::new()
        .service(list_users)
        .service(get_user)
        .service(create_user)
    )
    .bind("127.0.0.1:8080")?
    .run()
    .await
}
