use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "app")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    List,
    Get { id: u32 },
    Create { name: String, email: String },
    Delete { id: u32 },
}

async fn list_users() {
    println!("listing users");
}

async fn get_user(id: u32) {
    println!("getting user {}", id);
}

async fn create_user(name: String, email: String) {
    println!("creating user {} {}", name, email);
}

async fn delete_user(id: u32) {
    println!("deleting user {}", id);
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    match cli.command {
        Commands::List => list_users().await,
        Commands::Get { id } => get_user(id).await,
        Commands::Create { name, email } => create_user(name, email).await,
        Commands::Delete { id } => delete_user(id).await,
    }
}
