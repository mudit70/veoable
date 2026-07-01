# Veoable — MCP Tools Guide

This guide answers two questions:

1. **What questions can I ask the system?** — and which tool answers each one.
2. **What does every MCP tool do?** — name, purpose, parameters, what comes back.

Read it once front-to-back to get the lay of the land, then bookmark
[the question catalog](#what-questions-can-developers-ask) — that's the part
you'll come back to.

If you haven't installed yet, start with the [User Guide](userguide.md) and come
back when `veoable serve <graph.db>` is running.

---

## Table of contents

1. [How the tools fit together](#how-the-tools-fit-together)
2. [What questions can developers ask](#what-questions-can-developers-ask)
3. [Tool reference](#tool-reference)
   - [Orientation tools](#orientation-tools)
   - [Graph primitives](#graph-primitives)
   - [API surface tools](#api-surface-tools)
   - [Flow-walking tools](#flow-walking-tools)
   - [Screen / mobile tools](#screen--mobile-tools)
   - [Stitching tools](#stitching-tools)
   - [Hygiene tools](#hygiene-tools)
   - [Operational tools](#operational-tools)
   - [File inspection tools](#file-inspection-tools)
4. [Recipes — chaining tools for harder questions](#recipes--chaining-tools-for-harder-questions)
5. [Common pitfalls](#common-pitfalls)

---

## How the tools fit together

Every Veoable tool reads from one canonical SQLite graph. The graph is a typed
set of **nodes** (`APIEndpoint`, `ClientSideAPICaller`, `ClientSideProcess`,
`SourceFile`, `DatabaseTable`, …) connected by typed **edges**
(`CALLS_FUNCTION`, `READS`, `WRITES`, `RESOLVES_TO_ENDPOINT`, …). See the
[mental model](userguide.md#the-mental-model) in the user guide for the full
list.

The tools come in three layers:

- **Discovery / orientation** — `list_repositories`, `stats`,
  `describe_architecture`. Start here when you have no idea what's in the
  graph.
- **Bulk listings** — `list_server_endpoints`, `list_client_api_calls`,
  `list_screens`, etc. Each one returns a structured list of one node type
  with the most-asked-about adjacent context already joined in (e.g.
  `list_server_endpoints` includes the handler function, DB tables read, DB
  tables written, middleware chain — so an LLM rarely needs to chain further).
- **Targeted lookups** — `get_node`, `get_source_file`, `describe_file`,
  `describe_screen`. Zoom in on one thing.

Then there are **walks** (`walk_flows`, `walk_all_flows`, `walk_screen_flows`)
that traverse end-to-end flows, **impact-analysis** tools
(`impact_analysis`, `screen_impact`, `diff_flows`) that compute blast radii,
and a family of **stitching** tools that connect client API callers to server
endpoints when the automatic stitcher couldn't.

Practical heuristic: when an LLM gets a question, it usually wants one
*describe-something* call (for orientation) followed by one *list-something*
call (to get the structured data it'll reason over). Three+ tool calls usually
mean either (a) it's pulling source via `get_source_file`, or (b) it's
following a `walk_*` and inspecting branches.

---

## What questions can developers ask

This is the load-bearing section. Each subsection is a real question a
developer would type into Claude/Cursor, with the tool the LLM should reach
for. Phrase questions naturally — Veoable's MCP descriptions are tuned so a
modern LLM routes correctly.

### "What's in this project?"

> *"What's this codebase? Give me an overview."*

→ **`describe_architecture`** — returns endpoint domains grouped by route
prefix, all database tables, a frontend component summary. ~500 tokens.

> *"What repos does this project cover?"*

→ **`list_repositories`** — names + per-repo node counts. Always the first
call in a fresh session.

> *"How many endpoints / tables / functions are in this graph?"*

→ **`stats`** — aggregate counts. Optionally scoped to one repository.

---

### Backend / API surface

> *"What endpoints does the backend expose?"*

→ **`list_server_endpoints`** — every `APIEndpoint` with its handler, the DB
tables it reads, the DB tables it writes, the middleware chain, and whether
the handler resolved. Filter with `repository`.

> *"Which endpoints write to the `users` table?"*

The LLM should call `list_server_endpoints` and filter the result's `writesTo`
field, OR use **`impact_analysis`** with `tableName: "users"` for a more
focused answer.

> *"Are there endpoints nobody calls?"*

→ **`list_uncalled_endpoints`** — endpoints with zero incoming
`RESOLVES_TO_ENDPOINT` edges. Often dead code or candidates for removal.

> *"What middleware runs before this endpoint?"*

→ **`list_middleware`** — middleware aggregated by name with the endpoints
they protect and the position in the chain.

---

### Frontend / client surface

> *"What API calls does the frontend make?"*

→ **`list_client_api_calls`** — every `ClientSideAPICaller` with the
component, the UI event/lifecycle hook that triggers it, the HTTP method, and
the URL.

> *"Which calls are going to URLs we don't recognize?"*

→ **`list_unmatched_callers`** — callers without a `RESOLVES_TO_ENDPOINT`
edge. Either dynamic URLs, external APIs, or a stitching gap.

> *"What screens are in this app?"*

→ **`list_screens`** — every `Screen` with the processes (`useEffect`,
`onPress`, `onClick`, ...) defined in it, the API calls those processes
trigger, and the DB tables ultimately touched. The mobile/web-router
equivalent of `describe_architecture`.

> *"What are all the routes/pages in this app?"*

→ **`list_pages`** — same as `list_screens` but restricted to screens with a
non-null `routePath` (web routers + SSG/SSR pages).

---

### "What happens when the user does X?"

> *"What happens when a user clicks the Login button?"*

Two-step:
1. **`describe_screen`** with the screen name (e.g., `"LoginScreen"`) to find
   the process id for the button's handler.
2. **`walk_flows`** with that `processId` to traverse the full chain:
   process → caller → endpoint → handler → DB read/write → response.

Or in one shot for the whole screen:

→ **`walk_screen_flows`** — handles both steps. Pass `screenName` (e.g.
`"LoginScreen"`) and get every process's flow.

> *"What does this useEffect actually do?"*

→ **`walk_flows`** with the process id. If you don't have the id, use
`describe_screen` first.

> *"What's the full chain from `/api/orders/create` to the DB?"*

`list_server_endpoints` already returns `readsFrom` and `writesTo` for every
endpoint — usually enough. For the full call graph with intermediate
functions:

1. **`get_node`** with `type: "APIEndpoint"` and the route to find the
   endpoint id + handler id.
2. **`find_edges`** with `from: <handlerId>`, `edgeType: "CALLS_FUNCTION"`,
   to traverse the call graph.
3. **`get_source_file`** with intermediate `FunctionDefinition` ids if the
   LLM wants source context.

---

### "What would break if I changed X?"

> *"If I rename the `users.email` column, what breaks?"*

→ **`impact_analysis`** with `tableName: "users"` (column-level impact
requires checking returned `requestFields` — `impact_analysis` is
table-scoped today).

> *"If I change this endpoint, who calls it?"*

→ **`impact_analysis`** with `routePattern: "/api/orders"`. Returns upstream
client callers + downstream DB effects.

> *"If I touch this file, what flows pass through it?"*

→ **`impact_analysis`** with `filePath: "src/services/user-service.ts"`.

> *"Here's the file list from this PR's diff — which flows are affected?"*

→ **`diff_flows`** with `changedFiles: ["src/api/orders.ts", "src/db/users.ts", ...]`.
Returns every flow that crosses any of the changed files. Designed for PR
review.

> *"On the SettingsScreen, which other screens touch the same DB tables?"*

→ **`screen_impact`** with `screenName: "SettingsScreen"`. Returns the screen's
own API + table footprint plus other screens that share any of those tables.

---

### "Where's this defined?"

> *"Show me the source for the `userService.create` function."*

→ **`get_source_file`** with `filePath: "user-service.ts"` (substring match
works). For exact targeting, pass `nodeId` of the file or function node.

> *"What's in this file?"*

→ **`describe_file`** with a file path substring. Returns the file's
functions, endpoints, callers, processes, imports, exports — everything in
one call.

> *"What's on the CheckoutScreen — what events does it handle, what does it
> call?"*

→ **`describe_screen`** with `screenName: "CheckoutScreen"`.

---

### "Where am I using environment variable / config X?"

> *"Where do we read `process.env.STRIPE_KEY`?"*

→ **`list_env_vars`** — every `process.env.X` and `import.meta.env.X` access,
grouped by variable name with usage locations.

---

### "Help me clean up dead code"

> *"Which endpoints are dead?"*

→ **`list_uncalled_endpoints`**

> *"Which screens can never be reached by navigation?"*

→ **`list_unreachable_screens`** — screens with zero incoming `NAVIGATES_TO`
edges. Useful for finding orphaned React Native screens.

> *"Which DB tables aren't queried anywhere?"*

→ **`list_orphan_tables`** — tables declared in the schema but never read or
written. Either future-feature placeholders or a wiring oversight.

---

### "Why isn't this API call resolving to its endpoint?"

The "stitching" family. `RESOLVES_TO_ENDPOINT` edges connect each client API
caller to the server endpoint it would hit. The automatic stitcher catches
most cases; these tools handle the rest.

> *"Which client API calls don't have a resolved endpoint?"*

→ **`list_unmatched_callers`**

> *"What's stitched and what isn't — diagnose the gaps."*

→ **`stitch_report`** — comprehensive: what was stitched and why, what wasn't
and why, suggestions for fix.

> *"Propose matches for the unresolved ones."*

→ **`suggest_stitches`** — tiered results: deterministic (exact URL match),
heuristic (pattern prefix), ambiguous (multiple candidates).

> *"Find common patterns in unmatched callers."*

→ **`ai_stitch_review`** — looks for systematic mismatches across multiple
callers and proposes reusable rules (e.g., "every caller in `apps/web`
prefixes URLs with `/api` that the backend doesn't").

> *"Add a URL rewrite rule for this prefix mismatch."*

→ **`add_stitch_rule`** — writes a rule into the project config so future
analyses keep working. Use `dryRun: true` to preview. Requires
`--project-config` on serve.

> *"Re-run stitching with rules applied."*

→ **`apply_stitch_rules`** — pulls rules from the config, applies them, re-stitches.

> *"Just stitch everything that's confident enough."*

→ **`auto_stitch`** with a confidence threshold + `dryRun: true` to preview.

> *"Manually confirm / reject a specific match."*

→ **`confirm_stitch`** / **`reject_stitch`** — for one-off matches the LLM
proposes.

> *"Run the basic URL stitcher."*

→ **`stitch`** — the underlying engine. Safe to call multiple times
(idempotent via edge dedup).

---

### Navigation (mobile / SPA routing)

> *"How does a user get from `HomeScreen` to `OrderDetailScreen`?"*

→ **`navigation_graph`** — returns the screen-to-screen adjacency list, with
optional shortest-path query.

---

### Detecting bugs / incomplete data

> *"Where does the graph have holes?"*

→ **`list_incomplete_flows`** — flows that stopped before reaching the
database. Usually means a `RESOLVES_TO_ENDPOINT` is missing, or the handler
function isn't extracted, or the DB call uses dynamic SQL.

---

## Tool reference

Every tool has its full JSON schema available via `GET /api/tools` (REST) or
the MCP client's tool listing. This section gives you the **what** and the
**when** without re-typing the parameters.

### Orientation tools

| Tool | Returns | When to use |
| --- | --- | --- |
| `list_repositories` | Project name + repo list with node counts. | First call in any new session. |
| `stats` | Aggregate counts (endpoints, callers, tables, …) optionally scoped to a repo. | Token-efficient "how big is this" answers. |
| `describe_architecture` | Endpoint domains grouped by route prefix, all DB tables, frontend component summary. | LLM needs a one-shot overview. ~500 tokens. |

### Graph primitives

These are the low-level building blocks. Higher-level tools usually beat
them, but they're the right call when the higher-level tool doesn't fit.

| Tool | Returns | When to use |
| --- | --- | --- |
| `list_nodes` | Nodes filtered by `type` + optional property predicates. Pass `includeEvidence: true` for source snippets. | The LLM knows the type but not the id. |
| `get_node` | One node by `type` + content-addressed `id`. | Following an id from another tool's result. |
| `find_edges` | Edges filtered by `from` / `to` / `edgeType`. Any combination works; nulls are wildcards. | Traversing a custom path the bundled walks don't cover. |
| `get_source_file` | Source content for a `nodeId` or `filePath` (substring match; first hit wins). Includes surrounding context. | "Show me the actual code." Required server flag: `--project-root`. |

### API surface tools

| Tool | Returns | When to use |
| --- | --- | --- |
| `list_server_endpoints` | Every `APIEndpoint` with handler name, DB tables `readsFrom` and `writesTo`, middleware chain, `requestFields`, framework, `sourceFile`. Filter by `repository`. | Most "what does the backend do?" questions land here. |
| `list_client_api_calls` | Every outbound caller with component, trigger event, method, URL. | Inventorying the frontend's network behavior. |
| `list_unmatched_callers` | Callers without a resolved endpoint (excluding known external APIs). | Stitching gap analysis. |
| `list_uncalled_endpoints` | Endpoints no client reaches. | Dead-code sweeps. |
| `list_incomplete_flows` | Flows that stop before the DB. | Detecting graph holes — usually a stitching or extraction gap. |
| `list_middleware` | Middleware chain aggregated by name, with the endpoints it protects and the position in the chain. | "What runs before this endpoint?" |

### Flow-walking tools

A flow = a path through the graph starting at a `ClientSideProcess` (user
event or lifecycle hook).

| Tool | Returns | When to use |
| --- | --- | --- |
| `walk_flows` | Every flow starting from one specific `ClientSideProcess` id. Pass `includeEvidence: true` for source snippets. `maxHops` defaults to 1 — bump for microservice chains. | "What happens when this exact handler runs?" |
| `walk_all_flows` | Every flow in the graph. Supports `countOnly`, `completenessFilter`, `filterByTable`, `filterByEndpoint`, `filterByFile`. | Bulk analysis with a filter; reasoning over the entire app. |
| `walk_screen_flows` | All flows for processes inside a named screen. Shortcut for mobile work. | "What does the LoginScreen actually do end-to-end?" |
| `impact_analysis` | Upstream callers + downstream effects for a given endpoint (`routePattern`), table (`tableName`), or file (`filePath`). | "Blast radius if I touch X." |
| `diff_flows` | Every flow that crosses one of the given file paths (`changedFiles`). Designed for PR-review use. | "What does this PR's diff touch?" |

### Screen / mobile tools

Tuned for React Native + web-router screens, but the navigation and process
discovery work for any SPA that registers screen components.

| Tool | Returns | When to use |
| --- | --- | --- |
| `list_screens` | Every screen + its processes + the API calls those processes trigger + the DB tables touched. One row per screen. | The mobile equivalent of `describe_architecture`. |
| `list_pages` | Same as `list_screens` but filtered to screens with a `routePath` (web/SSG/SSR). One row per route. | "What pages does this Next.js / Remix app have?" |
| `describe_screen` | Component function, the screen's API calls, screens it navigates to, lifecycle hooks, event handlers. | Zooming in on one screen for "what does this do?" |
| `screen_impact` | The screen's API + table footprint **plus** every other screen that shares any of those tables. | Refactoring planning — what else breaks if a table changes? |
| `navigation_graph` | Adjacency list of `NAVIGATES_TO` edges. Optional `from` + `to` for shortest path. | "How do I get from screen A to screen B?" |
| `list_unreachable_screens` | Screens with no incoming navigation. | Finding orphans. |

### Stitching tools

Stitching = resolving client-side URLs to server-side endpoints by emitting
`RESOLVES_TO_ENDPOINT` edges. The automatic stitcher catches exact + obvious
patterns; this family handles the rest.

| Tool | What it does | When to use |
| --- | --- | --- |
| `stitch` | Run the URL stitcher. Idempotent. | Re-stitch after extracting more data. |
| `stitch_report` | Diagnostic: what stitched, what didn't, why, with suggested rules. | "Why is this caller unresolved?" |
| `suggest_stitches` | Three tiers: deterministic, heuristic, ambiguous. | LLM proposes matches for the user to confirm. |
| `confirm_stitch` | Persist a confirmed match with audit metadata. | The user picks one of `suggest_stitches`' results. |
| `reject_stitch` | Record a rejection. (Edge deletion isn't implemented yet.) | The user vetoes a proposal. |
| `auto_stitch` | Accept every suggestion above a confidence threshold. Supports `dryRun`. | Bulk one-shot cleanup. |
| `add_stitch_rule` | Add a URL rewrite rule to the project config. Requires `--project-config` on serve. Supports `dryRun`. | Systematic prefix mismatches across many callers. |
| `apply_stitch_rules` | Re-run stitching with config rules applied. | Pair with `add_stitch_rule`. |
| `ai_stitch_review` | Look across all unmatched callers for systematic patterns; propose rules. | Bootstrapping the rule set on a fresh project. |

### Hygiene tools

| Tool | Returns | When to use |
| --- | --- | --- |
| `list_uncalled_endpoints` | Endpoints with no client caller. | Dead-code review. |
| `list_unreachable_screens` | Screens with no incoming navigation. | Dead-screen review. |
| `list_orphan_tables` | DB tables that no `DatabaseInteraction` reads or writes. | Schema cleanup. |

### Operational tools

| Tool | Returns | When to use |
| --- | --- | --- |
| `list_env_vars` | Every `process.env.X` / `import.meta.env.X` access, grouped by name. | Pre-deploy environment audit; secrets review. |
| `list_middleware` | (Also in API surface) Middleware aggregated across endpoints. | Security/auth audits. |

### File inspection tools

| Tool | Returns | When to use |
| --- | --- | --- |
| `describe_file` | Functions, endpoints, callers, processes, imports, exports for one file (path substring match). | "What's in this file?" |
| `get_source_file` | Raw source with surrounding context. | "Show me the actual code." Requires `--project-root`. |

---

## Recipes — chaining tools for harder questions

Some questions can't be answered by a single tool. These recipes show the
chain.

### Recipe 1 — "Review this PR"

The user pastes a git diff or PR URL.

1. Extract the changed file paths from the diff.
2. **`diff_flows`** with `changedFiles: [...]` → every flow the PR touches.
3. For each affected flow, **`get_source_file`** on the changed lines for
   review context.
4. **`impact_analysis`** (use `routePattern` or `tableName`) for each
   touched endpoint or table to surface anything that might break beyond
   the diff.

### Recipe 2 — "Find the bug — clicking Save doesn't persist"

1. **`describe_screen`** for the screen with the Save button.
2. Identify the `onClick` process for Save.
3. **`walk_flows`** with that `processId`.
4. Inspect the returned flow — does it reach an endpoint? A DB write?
5. If it stops at the caller, **`list_unmatched_callers`** to confirm a
   stitching gap; **`suggest_stitches`** to propose a fix.
6. If it reaches the DB but writes the wrong table, **`get_source_file`** on
   the handler for the actual code.

### Recipe 3 — "Plan a column rename — `users.email` → `users.email_addr`"

1. **`impact_analysis`** with `tableName: "users"` → every endpoint and
   screen touching that table.
2. **`list_server_endpoints`** + filter on `writesTo` includes `users` to
   spot writers that may need a migration step.
3. For each touched endpoint, **`get_source_file`** to find every literal
   reference.
4. **`list_env_vars`** if there's a chance the column name appears in config
   or query templates.

### Recipe 4 — "Find dead code"

1. **`list_uncalled_endpoints`** → backend dead routes.
2. **`list_unreachable_screens`** → frontend orphans.
3. **`list_orphan_tables`** → unused DB tables.
4. Cross-check each suggestion with **`get_source_file`** — sometimes "dead"
   means "called dynamically" (string-built routes, runtime navigation).

### Recipe 5 — "Onboarding tour for a new engineer"

1. **`list_repositories`** + **`describe_architecture`** for the lay of the
   land.
2. **`list_screens`** + **`list_pages`** for the frontend inventory.
3. **`list_server_endpoints`** filtered per-repo for the backend inventory.
4. **`walk_all_flows`** with `countOnly: true` to size the call graph.
5. Pick one or two key flows and **`walk_flows`** with `includeEvidence: true`
   so the engineer sees a complete chain with source snippets.

### Recipe 6 — "Stitching gaps after first cold analyze"

1. **`stitch_report`** for the overview.
2. **`ai_stitch_review`** to propose rules across systematic patterns.
3. **`add_stitch_rule`** with `dryRun: true` to preview each rule, then
   commit it.
4. **`apply_stitch_rules`** to re-stitch.
5. **`list_unmatched_callers`** again to confirm shrinkage; iterate.

---

## Common pitfalls

**LLMs over-call `list_nodes` instead of `list_server_endpoints` / etc.**
The bulk listings include join-context (handler, tables, middleware) that
`list_nodes` doesn't. Prompt the LLM to "prefer the targeted `list_*` tool
when one exists."

**`get_source_file` returns nothing.** The server needs `--project-root` set
to the project root for path resolution. Restart the server with the flag.

**`walk_flows` says "process not found" but the screen has the handler.**
The `processId` you passed isn't a `ClientSideProcess` id — it's likely an
`APIEndpoint` or `FunctionDefinition` id. Use `describe_screen` to get the
right id, then `walk_flows`.

**`list_unmatched_callers` is huge.** First-time analyses often surface
hundreds. Use `ai_stitch_review` to find systematic patterns first — usually
3–5 rules clear 80% of the noise.

**Filters returning empty.** Substring filters on paths and names are
case-sensitive. `describe_file` with `LoginScreen` won't match `loginscreen.ts`.

**Out-of-date graph.** If the LLM gives answers that don't match your code,
your watcher hasn't refreshed yet. In `--on-demand` mode, press `r` in the
watch terminal before asking again.

---

## Where to go next

- [User Guide](userguide.md) — install, CLI, MCP setup, recommended workflows.
- [MCP Interaction Best Practices](MCPInteractionBestPractices.md) — patterns
  for prompting an AI assistant against the graph.
- `veoable tools` from the CLI — same content as this guide, generated
  directly from the live tool registry.
