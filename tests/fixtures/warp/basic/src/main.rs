use warp::Filter;

async fn list_users() -> Result<&'static str, warp::Rejection> { Ok("users") }
async fn get_user(_id: u32) -> Result<&'static str, warp::Rejection> { Ok("user") }
async fn create_user() -> Result<&'static str, warp::Rejection> { Ok("created") }
async fn delete_user(_id: u32) -> Result<&'static str, warp::Rejection> { Ok("deleted") }
async fn list_orders() -> Result<&'static str, warp::Rejection> { Ok("orders") }
async fn echo_path(_p: warp::path::Tail) -> Result<&'static str, warp::Rejection> { Ok("echo") }

#[tokio::main]
async fn main() {
    let users_list = warp::path!("api" / "users")
        .and(warp::get())
        .and_then(list_users);

    let user_by_id = warp::path!("api" / "users" / u32)
        .and(warp::get())
        .and_then(get_user);

    let create = warp::path!("api" / "users")
        .and(warp::post())
        .and_then(create_user);

    let delete = warp::path!("api" / "users" / u32)
        .and(warp::delete())
        .and_then(delete_user);

    let orders = warp::path!("api" / "orders")
        .and_then(list_orders);

    let echo = warp::path!("echo" / ..)
        .and_then(echo_path);

    let routes = users_list.or(user_by_id).or(create).or(delete).or(orders).or(echo);
    warp::serve(routes).run(([0, 0, 0, 0], 8080)).await;
}
