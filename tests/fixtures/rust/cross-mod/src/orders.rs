// Public free functions reachable from other modules via the
// canonical Rust module path.

pub fn cancel(_id: &str) -> bool {
    true
}

pub fn archive(_id: &str) -> bool {
    true
}

// Two functions with the same name in different modules (the other
// is in `ambig.rs`) — name-only lookups should be ambiguous and
// emit no edge.
pub fn duplicate() -> i32 {
    1
}
