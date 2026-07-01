// All four cross-mod resolution shapes exercised from a single
// caller function.

use orders::cancel;

pub fn dispatch() {
    // Shape 1: scoped call.
    let _a = orders::cancel("a");
    // Shape 2: use-resolved bare call (`use orders::cancel;` above).
    let _b = cancel("b");
    // Shape 3: crate:: prefix.
    let _c = crate::orders::archive("c");
    // Shape 4: ambiguous call — `duplicate` is defined in both
    // `orders` and `ambig`, so a bare unqualified call must NOT
    // resolve. The uniqueness gate suppresses the edge.
    let _d = duplicate();
    let _ = (_a, _b, _c, _d);
}

// Local helper — same-file calls already get edges from the
// extractor's per-file walk. The cross-mod resolver must NOT
// duplicate them.
fn duplicate() -> i32 {
    0
}

/// Replacement for `orders::cancel(id)` — see RFC-42.
///
/// The doc comment above must NOT cause a phantom CALLS_FUNCTION
/// edge from `commented_only` to `orders::cancel`. Same for the
/// string literal below — `"orders::archive(id)"` is data, not a
/// call site.
pub fn commented_only() -> &'static str {
    let _s = "orders::archive(id)";
    "ok"
}

/// Raw strings and nested block comments must also be masked so
/// they can't leak phantom call edges.
pub fn raw_and_nested() -> &'static str {
    let _raw = r#"orders::cancel(id) inside a raw string"#;
    /* outer /* nested orders::archive(id) */ still in outer */
    "ok"
}

// Same-name shadow between a top-level free fn and an impl method.
// The impl's `cancel` must NOT be re-attributed to this top-level fn
// when the resolver sees `orders::cancel(...)` inside the impl body —
// because the impl body is excluded entirely from `scanFnRanges`,
// no FunctionRange covers that call line and the resolver skips it.
fn cancel() -> i32 {
    // Top-level free fn that happens to share a name with the impl
    // method below. No call sites here.
    0
}

struct Stub;

impl Stub {
    /// This impl method calls `orders::cancel`. The cross-mod
    /// resolver MUST NOT attribute this call to the top-level
    /// free `cancel` above (which would happen if impl bodies
    /// weren't excluded from `scanFnRanges`).
    pub fn cancel(&self) -> bool {
        orders::cancel("from-impl")
    }
}
