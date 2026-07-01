mod service;

// Public function — exported
pub fn greet(name: &str) -> String {
    format_greeting(name)
}

// Private function — not exported
fn format_greeting(name: &str) -> String {
    format!("Hello, {}", name)
}

// Async function
pub async fn fetch_data(url: &str) -> String {
    format!("data from {}", url)
}

// Function with multiple params and generics
pub fn process<T: std::fmt::Display>(item: T, count: usize) -> String {
    format!("{}: {}", item, count)
}

// Function calling other functions
pub fn caller() {
    let msg = greet("Alice");
    println!("{}", msg);
    let greeting = format_greeting("Bob");
    println!("{}", greeting);
}

fn main() {
    caller();
}
