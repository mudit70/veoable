use actix_web::{get, post, put, delete, HttpResponse};

#[get("/users")]
async fn list_users() -> HttpResponse { HttpResponse::Ok().finish() }

#[get("/users/{id}")]
async fn get_user() -> HttpResponse { HttpResponse::Ok().finish() }

#[post("/users")]
async fn create_user() -> HttpResponse { HttpResponse::Created().finish() }

#[delete("/users/{id}")]
async fn delete_user() -> HttpResponse { HttpResponse::NoContent().finish() }
