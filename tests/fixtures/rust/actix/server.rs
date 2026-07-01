use actix_web::{get, post, put, delete, patch, HttpResponse};

#[get("/users")]
async fn list_users() -> HttpResponse { HttpResponse::Ok().finish() }

#[get("/users/{id}")]
async fn get_user() -> HttpResponse { HttpResponse::Ok().finish() }

#[post("/users")]
async fn create_user() -> HttpResponse { HttpResponse::Created().finish() }

#[put("/users/{id}")]
async fn update_user() -> HttpResponse { HttpResponse::Ok().finish() }

#[delete("/users/{id}")]
async fn delete_user() -> HttpResponse { HttpResponse::NoContent().finish() }

#[patch("/users/{id}")]
async fn patch_user() -> HttpResponse { HttpResponse::Ok().finish() }
