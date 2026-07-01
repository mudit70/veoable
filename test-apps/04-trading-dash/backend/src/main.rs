mod orders;
mod portfolio;
mod queue;
mod routes;
mod state;

use std::net::SocketAddr;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let state = state::AppState::new().await;
    let app = routes::router(state);

    let addr: SocketAddr = "0.0.0.0:3001".parse()?;
    let listener = TcpListener::bind(addr).await?;
    tracing::info!("listening on {}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}
