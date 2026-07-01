#[macro_use] extern crate rocket;

#[get("/<id>")]
fn get_user(id: u32) -> String { String::new() }

#[get("/")]
fn list_users() -> String { String::new() }

#[post("/")]
fn create_user() -> String { String::new() }

#[get("/")]
fn health() -> String { String::new() }

#[get("/")]
fn list_all() -> String { String::new() }

// Unrelated function whose name happens to collide with a Rust module
// name used in routes![] paths below. Verifies that scoped-path
// segments don't accidentally register module names as mount keys.
#[get("/static")]
fn users() -> String { String::new() }

// Function mounted at TWO different paths — should emit two endpoints.
#[get("/")]
fn ping() -> String { String::new() }

#[launch]
fn rocket() -> _ {
    rocket::build()
        // Scoped path inside routes! — only the final segment
        // (`list_users_via_module`) should be registered, NOT `mod_x`.
        .mount("/api/users", routes![get_user, list_users, create_user, mod_x::list_users_via_module])
        .mount("/health", routes![health])
        // ping is mounted twice at two different prefixes → two endpoints.
        .mount("/v1", routes![ping])
        .mount("/v2", routes![ping])
        // list_all isn't mounted anywhere — verifies unmounted
        // functions still emit unprefixed.
}
