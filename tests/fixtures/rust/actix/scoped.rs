use actix_web::{web, App, get, post, HttpResponse};

#[get("/")]
async fn list_root() -> HttpResponse { HttpResponse::Ok().finish() }

#[get("/")]
async fn list_users() -> HttpResponse { HttpResponse::Ok().finish() }

#[post("/")]
async fn create_user() -> HttpResponse { HttpResponse::Created().finish() }

#[get("/{id}")]
async fn get_user() -> HttpResponse { HttpResponse::Ok().finish() }

#[get("/health")]
async fn health() -> HttpResponse { HttpResponse::Ok().finish() }

fn make_app() -> App<()> {
    App::new()
        .service(
            web::scope("/api")
                .service(
                    web::scope("/users")
                        .service(list_users)
                        .service(create_user)
                        .service(get_user)
                )
                .service(health)
        )
        .service(list_root)
}
