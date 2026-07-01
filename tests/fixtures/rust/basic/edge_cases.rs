use std::fmt;

// Enum with impl block
pub enum Color {
    Red,
    Green,
    Blue,
}

impl Color {
    pub fn display(&self) -> &str {
        match self {
            Color::Red => "red",
            Color::Green => "green",
            Color::Blue => "blue",
        }
    }
}

impl fmt::Display for Color {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.display())
    }
}

// pub(crate) visibility
pub(crate) fn crate_visible() -> bool {
    true
}

// Function with closure parameter
pub fn with_callback<F: Fn(i32) -> i32>(f: F) -> i32 {
    f(42)
}

// Lifetime parameters
pub fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}

// Result return type
pub fn parse_number(s: &str) -> Result<i32, String> {
    s.parse::<i32>().map_err(|e| e.to_string())
}

// n1 fix: renamed from UserService to EdgeService to avoid collision
struct EdgeService {
    name: String,
}

impl EdgeService {
    fn new(name: String) -> Self {
        Self { name }
    }

    // Self:: call test (M1 fix)
    pub fn create_default() -> Self {
        Self::new("default".to_string())
    }
}

// Static method call test — EdgeService::new defined above
pub fn static_call_test() {
    let _svc = EdgeService::new("test".to_string());
}

// Forward reference test (M2 fix): calls helper_b defined later
pub fn forward_ref_caller() {
    let _result = forward_ref_target();
}

fn forward_ref_target() -> i32 {
    42
}

// Closure call attribution test (n2)
pub fn closure_test() {
    let _result = with_callback(|x| x + 1);
}
