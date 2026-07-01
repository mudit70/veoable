#[macro_use] extern crate rocket;

#[get("/users")]
fn list_users() -> &'static str {
    "[]"
}

#[get("/users/<id>")]
fn get_user(id: u32) -> String {
    format!("user {}", id)
}

#[post("/users")]
fn create_user() -> &'static str {
    "created"
}

#[delete("/users/<id>")]
fn delete_user(id: u32) -> &'static str {
    "deleted"
}

#[launch]
fn rocket() -> _ {
    rocket::build().mount("/", routes![list_users, get_user, create_user, delete_user])
}
