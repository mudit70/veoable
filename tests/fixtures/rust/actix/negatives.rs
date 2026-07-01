// Custom attribute — should NOT match
#[derive(Debug)]
struct MyStruct;

// Non-HTTP attribute
#[cfg(test)]
fn test_only() {}

// No attribute
async fn plain_handler() -> String { String::new() }
