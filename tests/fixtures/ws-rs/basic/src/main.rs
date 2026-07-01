use tokio_tungstenite::{accept_async, connect_async};
use tokio::net::TcpStream;

pub async fn handle_socket(stream: TcpStream) -> anyhow::Result<()> {
    let _ws = accept_async(stream).await?;
    Ok(())
}

pub async fn handle_scoped(stream: TcpStream) -> anyhow::Result<()> {
    let _ws = tokio_tungstenite::accept_async(stream).await?;
    Ok(())
}

pub async fn dial_feed() -> anyhow::Result<()> {
    let _ = connect_async("ws://api.example.com/feed").await?;
    Ok(())
}

pub async fn dial_secure() -> anyhow::Result<()> {
    let _ = connect_async("wss://secure.example.com/orders").await?;
    Ok(())
}

pub async fn dial_dynamic(url: &str) -> anyhow::Result<()> {
    // Dynamic URL — must NOT emit a caller.
    let _ = connect_async(url).await?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    Ok(())
}
