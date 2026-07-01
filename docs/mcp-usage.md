# Using the Veoable MCP server

A practical guide for connecting an LLM (Claude Code, Cursor, Windsurf, etc.) to a pre-built Veoable graph and asking it to reason about the codebase. This document is intended for end users and for the LLM itself — both audiences benefit from a clear list of "what you can ask" and "what you can do."

## What the MCP server is

`adorable serve <graph.db>` starts an MCP server (Model Context Protocol over stdio) backed by a graph database that Veoable produces from `adorable analyze` / `adorable project analyze`. An MCP-aware client (Claude Code etc.) connects, lists the available tools, and the LLM calls them as needed during a conversation.

The server exposes ~32 tools that read and (selectively) write the graph. It does **not** modify your source code. It can modify the project config file (`*.project.json`) only via explicit stitch-management tools, and those have `dryRun` previews.

---

## Setup (one-time, per project)

### 1. Build a graph

For a single repo:
```sh
adorable analyze /path/to/repo --output graph.db --fresh
```

For a multi-repo project (recommended for any monorepo):
```sh
cd /path/to/your-project
adorable project init .                # writes <name>.project.json
# edit the config to enumerate repos and (optionally) applications
adorable project analyze your-project.project.json --fresh
```

If you maintain multiple independent applications in one monorepo (e.g., a mobile client + admin web app, each with its own backend), declare them in the config so the stitcher doesn't cross-link them:
```json
{
  "applications": [
    { "name": "rn",    "repos": ["rn-client", "rn-backend"] },
    { "name": "admin", "repos": ["admin-web", "admin-backend"] }
  ]
}
```

### 2. Register the MCP server with your LLM client

For Claude Code, project-scoped (auto-loads when you `cd` into the repo):
```sh
cd /path/to/your-project
claude mcp add --scope project adorable -- adorable serve /absolute/path/to/your-project.db --project-config /absolute/path/to/your-project.project.json
```

The `--` separator is required so Claude Code doesn't intercept `--project-config` as one of its own flags. The `--project-config` argument is what lets the server read your `applications` declaration and apply scope to stitching tools.

For a global registration (loads in every session):
```sh
claude mcp add adorable -- adorable serve /absolute/path/to/your-project.db
```

### 3. Verify

```sh
claude mcp list
```
Should show `adorable: ... - ✓ Connected`.

### 4. Re-analyzing

When code changes:
```sh
adorable project analyze your-project.project.json --fresh
```
The MCP server reads the database lazily on each tool call — no restart needed; Claude picks up the new graph on the next question.

---

## Questions an LLM can answer (organized by category)

Each category lists realistic questions and the MCP tools the LLM will call to answer them. Use these as conversation starters or paste them directly into a session.

### Architecture & inventory

> What does this codebase look like at a high level?
- `describe_architecture`, `list_repositories`, `stats`

> How many endpoints, callers, screens, and DB tables are in the graph?
- `stats`

> What frameworks and libraries are detected per repo?
- `list_repositories`

> Show me every source file under `apps/api/src/auth/`.
- `list_nodes type=SourceFile` + filter

> What's the import/export graph for `src/auth/auth.controller.ts`?
- `describe_file filePath=...`

> What do the relationships between repos look like (who calls whom)?
- `describe_architecture`, `find_edges edgeType=RESOLVES_TO_ENDPOINT`

### Backend API surface

> Give me every endpoint in the rn-backend repo, grouped by HTTP method.
- `list_server_endpoints repository=rn-backend`

> Are there any endpoints that no frontend code calls?
- `list_uncalled_endpoints`

> Which endpoints are protected by JwtAuthGuard?
- `list_middleware name=JwtAuthGuard`

> What does the `POST /auth/login` endpoint do — what handler runs, what tables does it touch?
- `list_server_endpoints` + `walk_flows` from the handler

> Which endpoints share a database table with `/users/:id`?
- `impact_analysis routePattern="/users/:id"`

### Frontend / client API calls

> Show me every API call the rn-client makes.
- `list_client_api_calls repository=rn-client`

> Which client calls don't have a matching backend endpoint?
- `list_unmatched_callers`

> What environment variables does the codebase read at runtime?
- `list_env_vars`

### Screens & navigation (React / React Native)

> How does the user navigate from Login to Home?
- `navigation_graph`, `walk_screen_flows screenName=Login`

> What happens when a user opens the Player screen?
- `describe_screen screenName=Player`, `walk_screen_flows screenName=Player`

> Are there any screens declared in a navigator that nothing reaches?
- `list_unreachable_screens`

> What does the Login screen do — what processes, API calls, and navigation targets does it have?
- `describe_screen screenName=Login`

> What other screens would also break if the `users` table changed?
- `screen_impact tableName=users`

### End-to-end flow tracing

> What's the complete flow when a user taps Login → backend → database?
- `describe_screen Login` → `walk_screen_flows Login` → traces the path through the graph

> Show me every complete end-to-end flow in the project.
- `walk_all_flows completenessFilter=complete`

> Which flows are incomplete (don't reach a database write/read)?
- `list_incomplete_flows`

> What changed between this branch's flows and main's flows?
- `diff_flows` (requires two graph DBs)

> Walk every flow that touches the `payments` table.
- `walk_all_flows filterByTable=payments`

### Authentication & security

> Which endpoints are unauthenticated?
- `list_server_endpoints` + cross-reference with `list_middleware name=JwtAuthGuard` (or whatever guard you use)

> What does the auth flow look like end-to-end?
- `describe_screen Login` → `walk_screen_flows` → reaches `/auth/login` → handler → DB

> Which middleware runs before what endpoints?
- `list_middleware`

### Database / data flow

> What database tables exist and which endpoints read/write each?
- `list_nodes type=DatabaseTable`, then `impact_analysis tableName=<name>`

> Which endpoints write to the `users` table?
- `impact_analysis tableName=users`

> Which endpoints DON'T touch the database?
- `list_uncalled_endpoints` followed by checking `walk_flows` for empty `databaseHops`

> Which database tables exist but never get read or written?
- `list_orphan_tables` — surfaces tables declared in the schema (Prisma model, Mongoose Schema, etc.) that no `DatabaseInteraction` reads or writes. Either intentional (future feature) or a wiring oversight.

### Stitching diagnostics

> Are there callers I'd expect to be matched that aren't?
- `list_unmatched_callers`

> Why didn't this caller match? Show me what got considered.
- `suggest_stitches` (then look at the caller's tier)

> Show me every match the stitcher made and at what confidence.
- `stitch_report`

### Impact analysis (blast radius)

> What would break if I changed the `/api/users/:id` endpoint?
- `impact_analysis routePattern="/api/users/:id"`

> Which callers, screens, and downstream tables depend on this file?
- `impact_analysis filePath=src/auth/auth.controller.ts`

> If I rename the `users` table, what code do I have to update?
- `impact_analysis tableName=users`

### Source code retrieval

> Show me the source for the function with id `FunctionDefinition:abcd...`.
- `get_source_file nodeId=...`

> What's the body of the `POST /auth/login` handler?
- `list_server_endpoints` → grab handler id → `get_source_file nodeId=<handlerId>`

### Specific node inspection

> Tell me everything about node `Screen:abc123`.
- `get_node nodeType=Screen id=Screen:abc123`

> Find every CALLS_FUNCTION edge originating from this function.
- `find_edges from=FunctionDefinition:... edgeType=CALLS_FUNCTION`

---

## Actions an LLM can take

These tools mutate state. The graph DB is a regenerable artifact — anything you stitch can be re-derived. The project config (`*.project.json`) is your source of truth — modifications there persist into git.

### Add or update stitch rules in the project config

When the analyzer reports systematic prefix mismatches (e.g., frontend calls `/api/users/me` but backend route is `/users/:id`), promote a transformation rule into the config.

> Add a rule that strips `/api` from rn-client → rn-backend.
- `add_stitch_rule name="strip-api" from=rn-client to=rn-backend transformType=stripPrefix prefix=/api`
- Use `dryRun: true` first to preview the rule without writing.
- Idempotent: calling twice with identical args returns "Rule already exists; no change made." rather than appending a duplicate.

### Apply rules and re-stitch

> Re-run stitching with the rules now in the config.
- `apply_stitch_rules` — transforms caller URLs per the rules and emits new RESOLVES_TO_ENDPOINT edges for matches that the transform unlocks.

### Confirm or reject individual stitches

When the analyzer leaves an ambiguous match for human review:

> Confirm that this caller really does resolve to that endpoint.
- `confirm_stitch callerId=ClientSideAPICaller:... endpointId=APIEndpoint:...`

> Reject this proposed match — it's a false positive.
- `reject_stitch callerId=... endpointId=...`

### Auto-accept high-confidence matches in bulk

> Accept every deterministic stitch suggestion in one call.
- `auto_stitch minConfidence=deterministic` — use `dryRun: true` first to see the count before committing.

### Top-level stitch refresh

> Re-run the URL stitcher across the whole graph.
- `stitch` — idempotent; safe to call repeatedly. Honors the project's `applications` scope when configured.

### AI-assisted review of dynamic / unresolved callers

> Use AI to suggest matches for callers whose URLs the static analyzer couldn't resolve.
- `ai_stitch_review` — surfaces dynamic-URL callers and ranks endpoint candidates.

---

## Conventions and gotchas

### Empty results vs. errors

After the unified error contract (issue #277):
- Bad input → response has `isError: true` and content text parses to `{error, code, hint?}` where `code` is `NOT_FOUND`, `INVALID_INPUT`, or `PRECONDITION_FAILED`.
- Valid input with no matching results → no `isError`; response is the documented success shape (often an empty array or zero-count object).

If the LLM asks for a screen that doesn't exist, expect `{isError: true, code: 'NOT_FOUND', availableScreens: [...]}`. If it asks for screens with a filter that legitimately matches none, expect `{screens: []}` with no error.

### Stitching tools are write tools

`stitch`, `auto_stitch`, `confirm_stitch`, `reject_stitch`, `apply_stitch_rules`, `add_stitch_rule` all mutate graph or config state. The first five mutate the graph database, which is regenerable. Only `add_stitch_rule` mutates the project config file in your repo. That tool always supports `dryRun: true` and is idempotent — calling it twice with identical args is a no-op.

### Graph metadata persistence

The project config's `applications` declaration is persisted into the graph DB at analyze time, so MCP tools can re-apply the application scope on subsequent stitch operations even if the original config file moves. This is automatic; you don't need to do anything.

### Re-running analysis after code changes

The MCP server reads the database lazily on each tool call. After re-running `adorable project analyze --fresh`, the next MCP call sees the new graph. No need to restart the MCP server or the LLM session.

---

## Limitations the LLM should know about

These are real gaps; work around them by reading source directly via `get_source_file` or `[Read]` when applicable:

- **Class-component RN screens via HOCs that wrap an anonymous class expression** (`observer(class { render() {...} })`) — currently unsupported. The named-class form (`class X {}; export default observer(X)`) and `connect(...)(X)` chains DO resolve correctly (#289).
- **Inline event-handler arrows** still get extracted as FunctionDefinitions and have TRIGGERS edges, but anonymous arrows passed at positional argument positions sometimes lose the link.
- **Cross-file inline arrow handlers** (e.g., a saga handler defined as an arrow in another module) — the visitor's same-file fast path catches most cases; bare-expression handlers in unusual positions may not resolve.
- **Dynamic URL callers** (template strings with runtime parts) — surfaced via `egressConfidence: 'dynamic'`. Use `ai_stitch_review` to attempt resolution.
- **External services** (e.g., Cloudflare API) — appear in `list_unmatched_callers` because there's no matching internal endpoint. This is expected. Filter with `includeExternal: false`.

---

## Quick recipe: "what happens when the user taps Login?"

The canonical end-to-end question. Steps the LLM follows:

1. `describe_screen screenName=Login` — finds the component, processes (onPress, onChangeText, etc.), and screen-level navigation targets.
2. For each event handler process, `walk_flows processId=ClientSideProcess:...` — traces from the handler into the function it triggers, through any saga / thunk / query indirection (#256), to the `ClientSideAPICaller`.
3. The flow includes the resolved `APIEndpoint` (if stitched), its handler function, any database hops, and the response handlers on the client side.
4. If something looks broken (e.g., `componentFunction: null` or a flow stops before reaching the database), the LLM can fall back to `get_source_file` to read the actual code.

This recipe works because of the graph corrections shipped in waves 1–4: the RN handler→fn TRIGGERS edges (#266), the application-scope respect across stitching tools (#269), and the matcher rejecting empty-segment params (#268) all combine to make the flow walk land in the right place.
