// Fixture for #537 — framework-mcp-server-rust.
//
// Exercises the three load-bearing detection paths:
//   1. `#[tool(description = "...")]` — name defaults to method name
//   2. `#[tool(name = "...", description = "...")]` — explicit name wins
//   3. Bare `#[tool]` with no args
//
// Plus the negative paths the visitor must NOT lift:
//   - `#[tool_router]` on the impl itself (decorator, not a tool)
//   - `#[doc = "..."]` (sibling attribute)
//   - methods inside a non-impl module (would never reach the visitor)

use rmcp::{tool, tool_router, ServerHandler};

pub struct Counter;

#[tool_router]
impl Counter {
    #[tool(description = "Increment the counter by 1")]
    fn increment(&self) -> Result<(), String> {
        Ok(())
    }

    #[tool(name = "decrement_v2", description = "Decrement v2")]
    fn decrement(&self) -> Result<(), String> {
        Ok(())
    }

    #[tool]
    fn reset(&self) -> Result<(), String> {
        Ok(())
    }

    // Multiple sibling attributes — `#[doc]` precedes `#[tool]`,
    // and our walk must keep going past it.
    #[doc = "A docstring sibling"]
    #[tool(description = "Read the current value")]
    fn get(&self) -> Result<i64, String> {
        Ok(0)
    }

    // Not a tool — no `#[tool]` attribute. Must NOT be emitted.
    fn helper(&self) -> i64 {
        42
    }
}

// Second impl block — confirms multi-impl repos work.
pub struct Echo;

#[tool_router]
impl Echo {
    #[tool(description = "Echo input back")]
    fn echo(&self, input: String) -> Result<String, String> {
        Ok(input)
    }
}

// Scoped attribute path — `#[rmcp::tool(...)]`. The last segment is
// `tool`, so the visitor must accept it.
pub struct Scoped;

impl Scoped {
    #[rmcp::tool(description = "Scoped attribute path")]
    fn scoped_op(&self) -> Result<(), String> {
        Ok(())
    }
}

// Trait-impl form — `impl <Trait> for <Struct> { #[tool] fn ... }`.
// The visitor's `extractImplType` must pick the type AFTER `for`,
// not the trait name.
pub trait ToolRouter {
    fn route(&self) -> Result<(), String>;
}

pub struct Router;

impl ToolRouter for Router {
    #[tool(description = "Routed through a trait impl")]
    fn route(&self) -> Result<(), String> {
        Ok(())
    }
}
