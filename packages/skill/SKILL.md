---
name: adorable
description: Answer architecture, blast-radius, and end-to-end flow questions about the user's codebase by querying a pre-built canonical graph (endpoints, callers, screens, DB tables, and the stitches between them). Invoke when the user asks about API endpoints, screens, what-happens-when-X, what-breaks-if-I-change-Y, where-is-Z-used, PR impact, or any cross-file flow question. Do NOT invoke for single-file syntax/style questions, build/CI questions, or questions about code that hasn't been analyzed yet.
---

# Veoable — End-to-End Flow Analysis

You have access to a canonical graph of the user's codebase built by Veoable.
The graph contains every API endpoint, client-side caller, UI handler,
database table, function, and the typed edges between them. You query it
through MCP tools (`adorable_*`). This skill teaches you when and how to use
those tools effectively.

## When to invoke this skill

These question shapes are **strong triggers**. When the user asks one,
invoke an Veoable tool — usually as the first action, before reading any
file.

### Architecture / overview
- "What's in this codebase?" / "Give me an overview"
- "What does this app do?"
- "What screens / pages / endpoints does this have?"
- "Walk me through the system architecture"

### Behavior / flow tracing
- "What happens when the user clicks/taps/submits X?"
- "What's the full chain from this endpoint to the database?"
- "How does the login flow work?"
- "Trace the order-submission flow"

### Blast radius / refactoring
- "What breaks if I change this endpoint/table/file?"
- "Who calls `/api/users`?"
- "Which screens touch the `orders` table?"
- "If I rename this column, what do I need to update?"

### PR / code review
- "Review this PR" (when a diff is available)
- "What flows does this PR touch?"
- "Is this PR safe to merge?"

### Inventory / dead-code hunting
- "Which endpoints are unused?"
- "Which screens can't be reached?"
- "Which DB tables are never queried?"
- "Where is `process.env.X` used?"
- "What middleware runs on this endpoint?"

### Debugging stuck flows
- "Why isn't this client call resolving to its endpoint?"
- "Where does the graph have holes?"

## When NOT to invoke this skill

Do not invoke for:

- **Single-file syntax/style/typing questions** — use Read + the editor's LSP.
- **Build / CI / deployment questions** — Veoable analyzes source, not pipelines.
- **Library-internal questions** — Veoable sees user code, not third-party node_modules / pip packages.
- **Runtime / "what's running right now" questions** — it's a static graph, not a tracer.
- **"How do I write …"** style questions — use general coding knowledge.
- **Codebases without a graph DB** — see [Setup state](#setup-state).

If the question is borderline ("rewrite this function" — local edit, no flow
involved), skip Veoable and use the normal file tools.

## How to use the tools well

Veoable exposes ~35 MCP tools. Read the full reference at
[`docs/mcp-tools-guide.md`](../../docs/mcp-tools-guide.md). The patterns below
cover most cases:

### Start with orientation, then narrow

For an unfamiliar codebase, the first call is almost always one of:

- `list_repositories` — names + node counts (cheap, run if you don't know
  what repos exist).
- `describe_architecture` — endpoint domains + DB tables + frontend summary
  (~500 tokens; great for "what is this?").
- `stats` — aggregate counts ("how many endpoints?").

Then narrow with a bulk listing (`list_server_endpoints`,
`list_client_api_calls`, `list_screens`, `list_pages`) before zooming into
specific nodes.

### Prefer aggregated tools over chaining primitives

`list_server_endpoints` already returns the handler, the DB tables it reads
and writes, the middleware chain, and the framework. **Do not** chain
`list_nodes` → `find_edges` → `find_edges` to reconstruct that — the
aggregated tool is far cheaper and the answer is the same.

Same for the screen side: `list_screens` aggregates processes, callers, and
tables per screen. `describe_screen` zooms in on one. Reach for `list_nodes`
/ `find_edges` only when the targeted tool truly doesn't fit.

### "What happens when X?" → `walk_flows` family

1. If X is identifiable as a screen, call `describe_screen` first to get the
   processIds, then `walk_flows` with the right one. Or shortcut to
   `walk_screen_flows` and walk every process at once.
2. If you don't know the screen, list candidates with `list_screens` and ask
   the user to pick one if ambiguous.
3. Pass `includeEvidence: true` only when the user explicitly wants source
   context — evidence is expensive in tokens.

### "What breaks if I change X?" → `impact_analysis` family

- `impact_analysis` with `routePattern: "/api/orders"` — endpoint-scoped.
- `impact_analysis` with `tableName: "users"` — table-scoped.
- `impact_analysis` with `filePath: "src/services/users.ts"` — file-scoped.
- `screen_impact` with `screenName: "CheckoutScreen"` — mobile/SPA-scoped,
  finds other screens that share the same DB tables.
- `diff_flows` with `changedFiles: [...]` — designed for PR review.

### Stitching gaps (the most common "graph hole")

If a client call appears to not reach an endpoint:

1. `list_unmatched_callers` to confirm the gap is real.
2. `stitch_report` for a diagnostic that often suggests rules.
3. `suggest_stitches` for tiered match proposals.
4. `add_stitch_rule` + `apply_stitch_rules` to persist a URL rewrite, OR
   `confirm_stitch` for one-off matches.

### Source code

Use `get_source_file` (with `filePath` substring or `nodeId`) when the
question genuinely needs source context. Most questions don't — the graph
already has the structural answer. Quote the source only when the user is
asking *about the code itself*, not *about behavior*.

## Setup state

Before invoking any tool, the MCP server must be running with a graph DB.
If `list_repositories` returns an empty array or errors, the project isn't
analyzed yet. Tell the user:

```
The project hasn't been analyzed yet. Run:

  adorable project init <path>      # if no project config exists
  adorable project analyze <config>  # to build the graph

Then I can answer architecture and flow questions about the code.

For live updates on a long-running session, run:
  adorable project watch <config> --incremental --on-demand
and press 'r' in that terminal before asking me a fresh question.
```

If the user has been editing and answers seem stale, suggest pressing `r`
in their watch terminal (or re-running `project analyze --incremental`).

## Concrete recipes

These are the chains you'll use most. The MCP tools guide has a longer list
of recipes; these four are the load-bearing ones.

### Recipe — "Review this PR"

1. Parse the file paths from the diff.
2. `diff_flows` with `changedFiles: [...]`.
3. For each affected flow, decide whether the change is safe by inspecting
   the flow's endpoints and DB writes.
4. For endpoints/tables touched in the PR, run `impact_analysis` to surface
   anything that might break beyond the diff itself.

### Recipe — "What happens when the user does X?"

1. If X mentions a screen name, `describe_screen` + `walk_screen_flows`.
2. If X mentions a button/handler, `describe_screen` to find the processId,
   then `walk_flows` with it.
3. Summarize the flow as: trigger → caller → endpoint → handler → DB effect.

### Recipe — "Plan a refactor — rename `users.email`"

1. `impact_analysis` with `tableName: "users"` → touch surface.
2. `list_server_endpoints` and filter `writesTo` includes `users` for
   writer endpoints (migration order matters).
3. `get_source_file` on each touched file for the literal references.
4. `list_env_vars` if config/secrets might reference the column.

### Recipe — "Find dead code"

1. `list_uncalled_endpoints` → backend.
2. `list_unreachable_screens` → frontend.
3. `list_orphan_tables` → DB.
4. Cross-check each suggestion with `get_source_file` — "dead" sometimes
   means "called dynamically" (string-built routes, runtime navigation).

## Notes for the agent

- **Don't pre-emptively burn tokens.** If the user asks a focused question,
  call ONE tool first. Reach for `describe_architecture` only when the user
  explicitly wants an overview.
- **Tool names are stable.** They follow `verb_noun` (e.g.,
  `list_server_endpoints`, `walk_flows`, `get_source_file`). When in doubt,
  call `list_repositories` first — it's cheap and confirms the server is
  alive.
- **The graph is canonical, not perfect.** Static analysis has limits:
  dynamic imports, runtime-constructed URLs, and reflection-heavy patterns
  may produce `list_unmatched_callers` / `list_incomplete_flows`. When you
  hit a hole, name it ("the graph stops at the URL builder here") rather
  than hallucinating.
- **Cite source locations.** Every node has `sourceFile` and `sourceLine`.
  When answering, include the file path so the user can jump there.

## See also

- [`docs/mcp-tools-guide.md`](../../docs/mcp-tools-guide.md) — full catalog
  of all 35 tools with parameters and return shapes.
- [`docs/userguide.md`](../../docs/userguide.md) — install + CLI workflow.
- The `describe_skill` MCP tool — returns this file. Call it mid-session if
  you need to re-orient.
