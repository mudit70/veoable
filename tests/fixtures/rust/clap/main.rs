use clap::{Parser, Subcommand};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    List,
    Get { id: u32 },
    Create { name: String },
}

fn list_items() { println!("listing"); }
fn get_item(id: u32) { println!("getting {}", id); }
fn create_item(name: String) { println!("creating {}", name); }

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Commands::List => list_items(),
        Commands::Get { id } => get_item(id),
        Commands::Create { name } => create_item(name),
    }
}
