use actix_web::{web, HttpResponse, Responder};
use crate::models::User;
use crate::service::UserService;

pub async fn list_users(service: web::Data<UserService>) -> impl Responder {
    let users = service.get_all();
    HttpResponse::Ok().json(users)
}

pub async fn get_user(service: web::Data<UserService>, path: web::Path<u64>) -> impl Responder {
    let id = path.into_inner();
    match service.find_by_id(id) {
        Some(user) => HttpResponse::Ok().json(user),
        None => HttpResponse::NotFound().finish(),
    }
}

pub async fn create_user(service: web::Data<UserService>, body: web::Json<CreateUserRequest>) -> impl Responder {
    let user = service.create(body.name.clone(), body.email.clone());
    HttpResponse::Created().json(user)
}

pub async fn delete_user(service: web::Data<UserService>, path: web::Path<u64>) -> impl Responder {
    let id = path.into_inner();
    if service.delete(id) {
        HttpResponse::NoContent().finish()
    } else {
        HttpResponse::NotFound().finish()
    }
}

#[derive(serde::Deserialize)]
pub struct CreateUserRequest {
    pub name: String,
    pub email: String,
}

fn format_error(msg: &str) -> String {
    format!("{{\"error\": \"{}\"}}", msg)
}
