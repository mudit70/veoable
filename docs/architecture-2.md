# Architecture v2: Split Graphs with Human/AI-Assisted Stitching

## 1. Problem Statement

Architecture v1 builds a single knowledge graph in one pass: detect frontend callers, detect backend endpoints, auto-stitch them via URL pattern matching, and walk end-to-end flows. The stitching step is a lossy heuristic that produces false matches (23 flows instead of 6 in the sample app). This undermines confidence in the analysis and blocks several requirements:

- **R-5.4** (deterministic vs. contextual indicators) is partially met but the auto-stitcher silently mixes both
- **R-5.5/R-5.6** (human-in-the-loop resolution and persistence) is not implemented
- **UC-10** (resolve ambiguous flow stitching) has no interface
- **UC-9** (trace end-to-end flow) produces noisy results with false positives

Architecture v2 solves this by separating what's deterministic (each side's call graph) from what's heuristic (the cross-boundary matching), and making stitching an explicit, reviewable step.

## 2. Design Principles

1. **Each graph is independently useful.** The client graph answers frontend questions without needing the server graph, and vice versa.
2. **No silent heuristics.** Every connection is either AST-derived (high confidence) or explicitly confirmed (human/AI decision with audit trail).
3. **Incremental and reversible.** Stitching can be done one match at a time. Wrong stitches can be removed. Re-analysis preserves confirmed stitches (R-9, R-5.6).
4. **AI-augmented, not AI-dependent.** The system works fully manually. AI assistance accelerates stitching but is optional.
5. **Multi-repo native.** A project can span multiple repositories. Each repo produces its own graph. Stitching operates at the project level, connecting callers and endpoints across repo boundaries.

## 3. High-Level Architecture

### 3.1 Single-Repo Mode

```
                    +------------------+
                    |  Presentation    |
                    |  Layer           |
                    |  (NLP, GUI, MCP) |
                    +--------+---------+
                             |
                    +--------+---------+
                    |  Service Layer   |
                    |  Query, Impact,  |
                    |  Export, Notify   |
                    +--------+---------+
                             |
          +------------------+------------------+
          |                                     |
+---------+----------+             +------------+---------+
|  Client Graph      |             |  Server Graph        |
|  Builder           |             |  Builder             |
|  (Phase 1)         |             |  (Phase 2)           |
+---------+----------+             +------------+---------+
          |                                     |
          +------------------+------------------+
                             |
                    +--------+---------+
                    |  Stitching       |
                    |  Layer           |
                    |  (Phase 3)       |
                    +--------+---------+
                             |
                    +--------+---------+
                    |  Combined Graph  |
                    |  (Phase 4)       |
                    +--------+---------+
                             |
                    +--------+---------+
                    |  Knowledge Graph |
                    |  (SQLite)        |
                    +------------------+
```

### 3.2 Multi-Repo Mode (R-11.4)

When client and server code live in separate repositories — or when the backend is split into microservices — each repo is analyzed independently. The project concept groups them, and stitching operates across repo boundaries.

```
                         +──────────────────────────+
                         |        PROJECT           |
                         |                          |
    +────────────+       |   +────────────+         |   +────────────+
    | frontend/  | ────> |   | frontend.db|         |   |            |
    | (React)    | analyze   | (client    |         |   |            |
    +────────────+       |   |  graph)    |         |   |            |
                         |   +─────┬──────+         |   |            |
                         |         |                |   |            |
                         |    stitching layer       |   |            |
                         |    (cross-repo)          |   | project.db |
                         |      ╱      ╲            |   | (combined) |
                         |   +─┴────+ +──┴───+     |   |            |
    +────────────+       |   |user- | |post- |     |   |            |
    | user-svc/  | ────> |   |svc.db| |svc.db|     |   |            |
    | (Express)  | analyze   |(srvr | |(srvr |     |   |            |
    +────────────+       |   | grph)| | grph)|     |   |            |
                         |   +──────+ +──────+     |   |            |
    +────────────+       |                          |   |            |
    | post-svc/  | ────> |                          |   |            |
    | (Express)  | analyze                          |   |            |
    +────────────+       +──────────────────────────+   +────────────+
```

The project-level routing config tells the stitcher which repo serves which URL paths:

```json
{
  "project": "my-system",
  "repositories": [
    { "path": "./frontend", "label": "frontend" },
    { "path": "./user-service", "label": "user-api" },
    { "path": "./post-service", "label": "post-api" }
  ],
  "routing": [
    { "from": "frontend", "to": "user-api", "match": { "pathPrefix": "/api/users" } },
    { "from": "frontend", "to": "post-api", "match": { "pathPrefix": "/api/posts" } },
    { "from": "post-api", "to": "user-api", "match": { "pathPrefix": "/api/users" } }
  ]
}
```

When no routing config is provided, the stitcher matches callers against all endpoints across all repos by URL + method. Routing config narrows the search and eliminates cross-service ambiguity.

## 4. Phase 1: Client-Side Call Graph

### 4.1 What It Captures

The client graph traces every path a user interaction can take through frontend code, ending at the outbound API call boundary.

```
+-----------+      +------------+      +------------+      +-----------+
| UI Element|      | Event      |      | Handler    |      | API Call  |
| (button,  +----->| Handler    +----->| Function   +----->| (fetch,   |
|  form,    |      | (onClick,  |      | (inline or |      |  axios,   |
|  link)    |      |  onSubmit) |      |  named)    |      |  etc.)    |
+-----------+      +------------+      +------------+      +-----------+
                                            |
                                            v
                                       +----------+
                                       | Helper   |
                                       | Functions|
                                       | (wrappers|
                                       |  utils)  |
                                       +----------+
```

### 4.2 Node Types

| Node | Source | Confidence |
|------|--------|------------|
| `ClientSideProcess` | JSX event attributes, lifecycle hooks | exact (AST) |
| `FunctionDefinition` | All frontend functions including inline callbacks | exact (AST) |
| `ClientSideAPICaller` | `fetch()`, `axios()`, etc. with method + URL | exact or pattern (AST) |

### 4.3 Edge Types

| Edge | From | To | Purpose |
|------|------|----|---------|
| `TRIGGERS` | ClientSideProcess | FunctionDefinition | UI element invokes specific callback (not the whole component) |
| `CALLS_FUNCTION` | FunctionDefinition | FunctionDefinition | Function calls another function |
| `MAKES_REQUEST` | FunctionDefinition | ClientSideAPICaller | Function makes an HTTP call |

### 4.4 Key Improvement: Scope-Accurate Tracing

**v1 problem:** All event handlers in a component share the component function as their enclosing scope. An `onChange` handler appears to reach a `fetch()` call that only the `onSubmit` handler actually invokes.

**v2 solution:** Emit `FunctionDefinition` nodes for inline arrow functions in JSX attributes and lifecycle hook callbacks. The `TRIGGERS` edge connects each `ClientSideProcess` to its specific callback, not the component function. The flow walker then traces from that callback's scope.

```
v1 (wrong):                          v2 (correct):
CreateUserForm                       CreateUserForm
  |- onChange  ──┐                     |- onChange  → arrow_1 → setEmail (no fetch)
  |- onChange  ──┤── ALL reach ──>     |- onChange  → arrow_2 → setName  (no fetch)
  |- onSubmit  ──┘   fetch()          |- onSubmit  → arrow_3 → fetch('/api/users', POST)
```

This also applies to lifecycle hooks:

```
useEffect(() => {                     useEffect process
    fetch('/api/users')                 |- TRIGGERS → useEffect$callback
      .then(r => r.json())              |              |- MAKES_REQUEST → fetch GET /api/users
      .then(setUsers);
}, []);
```

Custom hooks are handled naturally by the call graph — `UserList` calls `useUsers`, which contains the `useEffect`, so BFS from the component reaches the hook's callback and its fetch call.

### 4.5 Key Improvement: Named Function Reference Resolution

**v1 problem:** `onClick={handleRefresh}` can't follow the reference to `handleRefresh`'s body (issue #83).

**v2 solution:** When the React visitor sees a JSX attribute whose value is an identifier (not an inline arrow), resolve the identifier via ts-morph symbol resolution and emit a `TRIGGERS` edge to the resolved `FunctionDefinition`.

### 4.6 What the Client Graph Answers (Standalone)

These map to requirements and use cases that don't need the server graph:

| Question | Requirement | Use Case |
|----------|-------------|----------|
| What UI interactions exist? | R-3.3 | UC-7 |
| What does each interaction do? | R-4.3 | UC-8 |
| What API calls does each interaction make? | R-3.2 | UC-5, UC-6 |
| What's the request shape (method, URL, body)? | R-4.2 | UC-6 |
| Which interactions share API calls? | R-7.1 | UC-11 |
| Which API calls have no matching UI trigger? | R-7.3 | UC-19 |

## 5. Phase 2: Server-Side Call Graph

### 5.1 What It Captures

The server graph traces every path from an API endpoint through business logic to database interactions.

```
+-----------+      +------------+      +------------+      +------------+
| API       |      | Handler    |      | Service    |      | Database   |
| Endpoint  +----->| Function   +----->| Functions  +----->| Interaction|
| (route)   |      |            |      |            |      | (read/write|
+-----------+      +------------+      +------------+      | /delete)   |
                                                           +-----+------+
                                                                 |
                                                           +-----v------+
                                                           | Database   |
                                                           | Table      |
                                                           +------------+
```

### 5.2 Node Types

| Node | Source | Confidence |
|------|--------|------------|
| `APIEndpoint` | Express/Fastify/etc. route declarations | exact (AST) |
| `FunctionDefinition` | Handler, service, utility functions | exact (AST) |
| `DatabaseInteraction` | ORM calls (Prisma, etc.) | exact or heuristic (AST) |
| `DatabaseTable` | Schema files (Prisma schema, migrations) | exact |
| `DatabaseColumn` | Schema files | exact |

### 5.3 Edge Types

| Edge | From | To | Purpose |
|------|------|----|---------|
| `HANDLES` | APIEndpoint | FunctionDefinition | Endpoint routes to handler |
| `CALLS_FUNCTION` | FunctionDefinition | FunctionDefinition | Handler calls service, etc. |
| `PERFORMS` | FunctionDefinition | DatabaseInteraction | Function performs DB operation |
| `READS` | DatabaseInteraction | DatabaseTable | Query reads from table |
| `WRITES` | DatabaseInteraction | DatabaseTable | Mutation writes to table |

### 5.4 Key Improvement: Cross-File Handler Resolution

**v1 problem:** When `app.get('/path', handler)` imports `handler` from another file, the Express visitor sets `handlerFunctionId: null` (issue #86).

**v2 solution:** Follow imports via ts-morph symbol resolution. When the handler identifier resolves to an `ImportSpecifier`, trace to the source module and compute the target `FunctionDefinition` id using the import path. This requires exposing `rootDir` in `TsVisitContext`.

### 5.5 Key Improvement: Router Composition

**v1 problem:** Routes declared on sub-routers (`router.get('/', handler)`) are emitted with their relative path, not the full mounted path.

**v2 solution:** Detect `app.use('/prefix', router)` mount calls. In Phase 2 (cross-file resolution), compose the mount prefix with each router's relative routes to produce the full path (e.g., `/api/users` + `/` → `/api/users`, `/api/users` + `/:id` → `/api/users/:id`).

### 5.6 Middleware Chains

Express routes often include middleware: `app.get('/path', auth, validate, handler)`. The handler is the last argument; middleware functions are everything in between. The server graph records middleware as metadata on the endpoint and emits the `HANDLES` edge to the final handler. Deeper middleware analysis (what each middleware adds to `req`) is a detail analyzer concern (R-4.1).

### 5.7 Cascading Database Effects

When the Prisma schema defines cascade rules (`onDelete: Cascade`), a `prisma.user.delete()` also removes related Post rows. The schema parser can emit `CASCADE_DELETES` edges between tables so the graph surfaces these implicit writes:

```
prisma.user.delete()  → WRITES (delete) → User table
                                            |- CASCADE_DELETES → Post table
```

### 5.8 What the Server Graph Answers (Standalone)

| Question | Requirement | Use Case |
|----------|-------------|----------|
| What API endpoints exist? | R-3.1 | UC-3 |
| What does each endpoint do? | R-4.1 | UC-4 |
| What database tables does each endpoint touch? | R-4.1.4 | UC-4 |
| What's the request/response format? | R-4.1.2, R-4.1.3 | UC-4 |
| Which endpoints are dead (no callers)? | R-7.3 | UC-19 |
| Which tables are orphaned? | R-7.3 | UC-19 |
| What's the impact of changing an endpoint? | R-7.2 | UC-11 |

## 6. Phase 3: Stitching Layer

### 6.1 Overview

Stitching connects the client graph's outbound API calls to the server graph's inbound API endpoints. This is the only heuristic step in the pipeline, and it's made explicit.

```
CLIENT GRAPH                              SERVER GRAPH
+------------------+                      +------------------+
| POST /api/users  |  === stitch ===>     | POST /api/users  |
| (exact, high)    |                      | createUserHandler|
+------------------+                      +------------------+

| GET /api/users/  |  === ambiguous ===>  | GET /api/users/:id         |
| (pattern)        |                      | GET /api/users/:userId/posts|
+------------------+                      +----------------------------+
      |                                         |
      +---- human/AI resolves to ------>  GET /api/users/:id
```

### 6.2 Stitching Strategies (R-5)

The stitcher uses a cascade of strategies, from most certain to least. Each stitch records which strategy produced it (R-5.4). Strategies are tried in order; once a unique match is found, later strategies are skipped.

| # | Strategy | Confidence | Method | Covers |
|---|----------|-----------|--------|--------|
| 1 | **Exact URL + method match** | `deterministic` | String equality | Static URLs like `fetch('/api/users')` |
| 2 | **Segment-count matching** | `deterministic` | Template with N spans matches route with N params after prefix | `` fetch(`/api/users/${id}`) `` → `/api/users/:id` (1 span, 1 param) |
| 3 | **Shared constants match** | `deterministic` | Both sides reference the same route constant (e.g., `API_ROUTES.GET_USER`) | Projects that define routes in a shared module |
| 4 | **Pattern matching** | `heuristic` | URL prefix matches route prefix, ranked by specificity | Ambiguous cases, multiple candidates |
| 5 | **AI contextual analysis** | `contextual` | LLM reads source code via evidence (#96), reasons about intent | When heuristics produce multiple candidates |
| 6 | **Human confirmation** | `confirmed` | User selects correct match | Final authority for ambiguous cases |

Strategy 2 (segment-count) deserves elaboration because it's the key improvement over v1. The fetch visitor emits the full template structure — not just the prefix, but the number of interpolation spans and the literal parts between them. This tells the stitcher exactly how many dynamic segments the URL has:

```
fetch(`/api/users/${id}`)
  Template parts:  ['/api/users/', '']
  Spans:           1
  Total segments:  3 (api, users, <value>)

  Matches:    GET /api/users/:id           (3 segments) ✓
  Rejects:    GET /api/users/:userId/posts (4 segments) ✗
```

### 6.3 Base URL and Proxy Resolution

In multi-repo projects, the frontend may reach the backend via a base URL, API client configuration, or dev proxy:

| Scenario | Client Code | Resolution |
|----------|-------------|------------|
| Same-origin / proxy | `fetch('/api/users')` | Match path directly |
| Full URL | `fetch('http://user-svc:3000/api/users')` | Strip origin, match on path |
| API client baseURL | `userApi.get('/users')` where `baseURL = '/api'` | Compose baseURL + path = `/api/users` |
| Proxy rewrite | `fetch('/user-api/users')` with proxy rule `/user-api/* → /api/*` | Apply rewrite, then match |

The project routing config (section 3.2) handles scenarios 2-4 by declaring how the frontend reaches each backend. When no config is provided, the stitcher matches on path alone (works for scenario 1).

### 6.4 Service-to-Service Calls

In microservice architectures, backends call other backends. The fetch visitor detects `fetch()` calls in server code the same way it detects them in client code — producing `ClientSideAPICaller` nodes in the server graph. These are stitched to endpoints in other repos using the same cascade:

```
post-service:                                 user-service:
  createPost()                                  GET /api/users/:id
    fetch(`http://user-svc/api/users/${id}`)    getUserHandler
    prisma.post.create()                        → reads User table
    → writes Post table

Stitch: post-service's fetch → user-service's GET /api/users/:id
```

The project routing config declares this with a `"from": "post-api", "to": "user-api"` entry. End-to-end flows can then span multiple repos and databases.

### 6.5 Stitching Interface (MCP Tools)

```
list_client_api_calls()
  Returns all outbound API calls from the client graph with their
  trigger context:
  [
    {
      id: "...",
      component: "CreateUserForm",
      trigger: "onSubmit",
      method: "POST",
      url: "/api/users",
      urlConfidence: "exact",
      sourceFile: "src/components/CreateUserForm.tsx",
      sourceLine: 11
    },
    ...
  ]

list_server_endpoints()
  Returns all API endpoints from the server graph with their
  downstream effects:
  [
    {
      id: "...",
      method: "POST",
      route: "/api/users",
      handler: "createUserHandler",
      writesTo: ["User"],
      readsFrom: [],
      sourceFile: "src/server.ts",
      sourceLine: 46
    },
    ...
  ]

suggest_stitches()
  Returns proposed matches with confidence and reasoning:
  [
    {
      callerId: "...",
      endpointId: "...",
      confidence: "deterministic",
      strategy: "exact-url",
      reason: "POST /api/users matches POST /api/users exactly"
    },
    {
      callerId: "...",
      candidates: ["endpoint-A", "endpoint-B"],
      confidence: "ambiguous",
      strategy: "pattern",
      reason: "prefix /api/users/ matches both /api/users/:id
               and /api/users/:userId/posts"
    },
    ...
  ]

confirm_stitch(callerId, endpointId, reason?)
  Human or AI confirms a specific match. Stored permanently.
  Optional reason field for audit trail.

reject_stitch(callerId, endpointId, reason?)
  Human or AI rejects a proposed match.

auto_stitch(options?)
  Accept all suggestions at or above the specified confidence.
  Options:
    minConfidence: "deterministic" (default) | "heuristic" | "all"
    dryRun: boolean  -- preview without committing
```

### 6.6 Stitching Modes

| Mode | How It Works | Best For | Covers |
|------|-------------|----------|--------|
| **Manual** | Human reviews each proposed match | Critical systems, compliance | UC-10 |
| **AI-assisted** | LLM reviews ambiguous matches using `get_source_file`, proposes resolutions, human approves | Typical workflow | UC-10, UC-14 |
| **Auto + review** | Auto-accept deterministic, surface ambiguous for review | Fast iteration | UC-2 |
| **Full auto** | Accept everything (v1 behavior) | Quick exploration | UC-2 |

### 6.7 API Contract Discovery (Future Enhancement)

When a project has API contracts (OpenAPI specs, GraphQL schemas, tRPC routers), the stitcher can use them as a high-confidence matching signal. For example, if the frontend uses a generated client from an OpenAPI spec, the generated function names match `operationId` values, which map to server-side handler names. This is a deterministic match even when the URL at the call site is dynamic.

### 6.8 Persistence (R-5.6, R-9)

Confirmed stitches are stored as `RESOLVES_TO_ENDPOINT` edges with metadata:

```json
{
  "edgeType": "RESOLVES_TO_ENDPOINT",
  "from": "ClientSideAPICaller:...",
  "to": "APIEndpoint:...",
  "fromRepository": "frontend-app",
  "toRepository": "user-service",
  "confirmedBy": "human",
  "confirmedAt": "2026-04-10T...",
  "strategy": "pattern",
  "confidence": "confirmed",
  "reason": "Developer confirmed this targets the user detail endpoint"
}
```

The `fromRepository` and `toRepository` fields are present on all stitch edges. For single-repo projects they share the same value.

On re-analysis (R-9):
- If both the caller and endpoint still exist with the same signatures, the confirmed stitch is preserved.
- If either changed, the stitch is flagged for re-review.
- New unstitched callers/endpoints are surfaced for stitching.

## 7. Phase 4: Combined Graph

### 7.1 Assembly

Once stitching is complete, the combined graph is the union of client graph, server graph, and confirmed stitch edges:

```
+--------+   TRIGGERS   +----------+   MAKES_REQUEST   +--------+
| onClick| -----------> | arrow_fn | ----------------> | fetch  |
| :37    |              | :37-39   |                   | DELETE |
+--------+              +----------+                   | /api/  |
                                                       | users/ |
                                                       +---+----+
                                                           |
                                              RESOLVES_TO  | (confirmed)
                                              _ENDPOINT    |
                                                           v
+--------+   READS      +----------+   CALLS_FUNCTION  +--------+
| User   | <----------- | prisma.  | <---------------- | delete |
| table  |              | user.    |                   | User   |
|        |              | delete() |                   | Handler|
+--------+              +----------+                   +---+----+
                                                           ^
                                                  HANDLES  |
                                                           |
                                                       +---+----+
                                                       | DELETE  |
                                                       | /api/  |
                                                       | users/ |
                                                       | :id    |
                                                       +--------+
```

### 7.2 End-to-End Flow (R-5, UC-9)

A complete flow in v2 has clear provenance at every step:

```
Step  Layer      Node                    Confidence    Strategy
────  ─────      ────                    ──────────    ────────
1     Client     onClick (UserDetail:37) exact         AST
2     Client     arrow_fn (inline)       exact         AST / TRIGGERS edge
3     Client     fetch(DELETE /users/*)  exact         AST / MAKES_REQUEST edge
4     Stitch     → DELETE /api/users/:id confirmed     human / confirm_stitch
5     Server     deleteUserHandler       exact         AST / HANDLES edge
6     Server     deleteUser              exact         AST / CALLS_FUNCTION edge
7     Server     prisma.user.delete()    exact         AST / PERFORMS edge
8     Server     User table              exact         WRITES edge
```

Every step shows its confidence and strategy. The user can see that steps 1-3 and 5-8 are deterministic (AST-derived), while step 4 was a confirmed stitch (R-5.4).

### 7.3 What the Combined Graph Answers

| Question | Requirement | Use Case |
|----------|-------------|----------|
| What happens end-to-end when a user clicks X? | R-5 | UC-9 |
| Which flows are fully deterministic vs. have contextual links? | R-5.4 | UC-9 |
| What's the blast radius of changing endpoint Y? | R-7.2 | UC-11 |
| Which flows are affected by this deploy? | R-7.4 | UC-20 |
| Show me the full architecture diagram | R-8.2 | UC-17 |
| Debug: what's the path from this button to this DB error? | R-4 | UC-12 |

## 8. Requirements Coverage Matrix

| Requirement | v1 Status | v2 Coverage |
|-------------|-----------|-------------|
| **R-3.1** API Endpoint Detection | Done (Express) | Same + cross-file handler resolution |
| **R-3.2** Client-Side Caller Detection | Done (fetch) | Same + wrapper function support |
| **R-3.3** Client-Side Process Detection | Done (React) | Same + scope-accurate tracing |
| **R-4.1** Endpoint Detail Analyzer | Partial | Server graph provides complete flow |
| **R-4.2** Caller Detail Analyzer | Partial | Client graph provides complete flow |
| **R-4.3** Process Detail Analyzer | Partial | Client graph provides complete flow |
| **R-5.1** End-to-end flow chains | Done but noisy | Clean flows via confirmed stitches |
| **R-5.2** Deterministic methods first | Partial | Explicit cascade: exact → segment-count → pattern → AI → human |
| **R-5.3** Fallback strategies | Not implemented | AI contextual analysis + human-in-the-loop |
| **R-5.4** Indicate deterministic vs. contextual | Partial (confidence field) | Every step labeled with strategy |
| **R-5.5** Human-in-the-loop | Not implemented | `confirm_stitch` / `reject_stitch` tools |
| **R-5.6** Persist resolutions | Not implemented | Confirmed stitches stored as edges with metadata |
| **R-6.1** Knowledge Graph | Done | Same (SQLite, content-addressed) |
| **R-6.2** MCP Server | Done (8 tools) | Extended with stitching tools + `get_source_file` |
| **R-7.1** Search and Filter | Partial | Client/server graph query tools |
| **R-7.2** Impact Analysis | Not implemented | Enabled by combined graph traversal |
| **R-7.3** Dead Code Detection | Not implemented | Client graph: orphan processes. Server graph: orphan endpoints/tables |
| **R-9** Incremental Re-Analysis | Not implemented | Confirmed stitches preserved across re-analysis |
| **R-11.4** Multi-repo projects | Not implemented | Project concept, per-repo graphs, cross-repo stitching with routing config |
| **UC-1** Set Up a Project | Not implemented | `veoable project create`, `add-repo`, routing config |
| **UC-9** Trace End-to-End Flow | Done but noisy | Clean flows with provenance, can span repos |
| **UC-10** Resolve Ambiguous Stitching | Not implemented | Full stitching interface |
| **UC-14** AI-Assisted via MCP | Partial | AI can stitch using evidence + source retrieval |

## 9. Migration Path

### Step 1: Improve Client Graph (#99)
- Emit `FunctionDefinition` nodes for inline JSX callbacks and useEffect callbacks
- Add `TRIGGERS` edges from `ClientSideProcess` to callback functions
- Resolve named function references in JSX attributes (#83)
- Add `list_client_api_calls` MCP tool
- See: `docs/client-side-call-graph.md` for full design

### Step 2: Improve Server Graph (#100)
- Cross-file handler resolution (#86)
- Router composition (`app.use('/prefix', router)`)
- Middleware chain recording
- Add `list_server_endpoints` MCP tool (with downstream DB effects)
- See: `docs/server-side-call-graph.md` for full design

### Step 3: Add Stitching Layer (#101)
- Segment-count heuristic (template spans → route params matching)
- Shared constants resolution
- `suggest_stitches` / `confirm_stitch` / `reject_stitch` / `auto_stitch` tools
- Store confirmed stitches with cross-repo metadata
- See: `docs/cross-boundary-stitching.md` for full design

### Step 4: Update Flow Walker (#102)
- Only walk flows through confirmed stitches
- Label each step with confidence + strategy
- Scope-narrowed client-side traversal via TRIGGERS edges
- Unstitched callers/endpoints remain visible in their respective graphs

### Step 5: CLI and Multi-Repo (#103)
- `--stitch-mode none|auto-exact|auto-all` flag
- Default to `none` (build graphs only)
- `veoable project create/add-repo/analyze/stitch` commands
- Project routing config for cross-repo stitching
- Merged project database

## 10. Detailed Design Documents

The following documents provide implementation-level detail for each phase:

- **`docs/client-side-call-graph.md`** — Per-file AST walk algorithm, JSX attribute resolution (5 forms), useEffect/custom hook tracing, cross-file import resolution, scope-accurate BFS, complete sample app diagram
- **`docs/server-side-call-graph.md`** — Handler resolution (5 forms), middleware chains, router composition, database interaction tracing, cascading deletes, NestJS/Fastify patterns, complete sample app diagram
- **`docs/cross-boundary-stitching.md`** — 6-strategy cascade with examples, multi-repo project model, base URL/proxy resolution, service-to-service calls, API contract discovery, merged vs. federated database approaches

## 11. Relationship to Other Issues

- **#96** (source evidence) enables AI-assisted stitching — the LLM can read actual source code to resolve ambiguities
- **#97** (accuracy catalogue) lists the 12 inaccuracy sources this architecture addresses
- **#98** (split graph proposal) is the issue that proposed this architecture
- **#99–#103** (migration steps 1–5) are the implementation issues for this architecture
- **#83** (named function reference gap) is resolved by Step 1 client graph improvements
- **#86** (cross-file handler resolution) is resolved by Step 2 server graph improvements
