// Cross-module call resolution fixture (#546).
//
// Exercises four shapes:
//   1. Scoped call:     `orders::cancel(...)` from routes.rs.
//   2. Use-resolved bare: `cancel(...)` after `use orders::cancel;`.
//   3. crate:: prefix:  `crate::orders::archive(...)`.
//   4. Unresolved name: a call to an identifier that's not in scope
//      (should NOT emit an edge; uniqueness gating).

mod orders;
mod routes;
mod ambig;

fn main() {
    routes::dispatch();
}
