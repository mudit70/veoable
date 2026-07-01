# Cross-Boundary Stitching: Matching Client API Calls to Server Endpoints

## 1. The Problem

The client graph ends with outbound API calls. The server graph starts with inbound API endpoints. Connecting them is the hardest part of the pipeline because the connection crosses a network boundary — no import chain, no call edge, no type system links them. The only signal is URL pattern + HTTP method, and that signal is often ambiguous.

```
CLIENT GRAPH                    NETWORK                    SERVER GRAPH
                                BOUNDARY
+----------+                       |                    +-------------------+
| fetch()  |   POST /api/users     |                    | POST /api/users   |
| POST     | ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─| ─ ─ ─ ─ ─ ─ ─ ─> | createUserHandler |
| /api/usr |                       |                    +-------------------+
+----------+                       |
                                   |
+----------+                       |                    +-------------------+
| fetch()  |   GET /api/users/${id}|                    | GET /api/users/:id|
| GET      | ─ ─ ─ ─ ─ ? ─ ─ ─ ─ ─| ─ ─ ─ ? ─ ─ ─ ─> | getUserHandler    |
| /api/    |         which one?    |                    +-------------------+
| users/   |                       |                    | GET /api/users/   |
+----------+                       |                    | :userId/posts     |
                                   |                    | listPostsHandler  |
                                   |                    +-------------------+

No import chain exists across the boundary.
The only signal is the URL pattern and HTTP method.
```

This document describes how to match them — within the same repository, across repositories in the same project, and across independently deployed services.

## 2. The Stitching Cascade

Stitching uses a cascade of strategies, from most certain to least. Each stitch records which strategy produced it, satisfying R-5.4 (deterministic vs. contextual indicators).

```
+──────────────────────────────────────────────────────────+
|  Strategy 1: Exact URL + Method Match                    |
|  confidence: deterministic                               |
|  fetch('/api/users') ↔ app.get('/api/users')             |
+───────────────────────────┬──────────────────────────────+
                            | unmatched callers
                            v
+──────────────────────────────────────────────────────────+
|  Strategy 2: Segment-Count Match                         |
|  confidence: deterministic                               |
|  fetch(`/api/users/${id}`) [1 span] ↔                    |
|    /api/users/:id [1 param after prefix]                 |
+───────────────────────────┬──────────────────────────────+
                            | unmatched callers
                            v
+──────────────────────────────────────────────────────────+
|  Strategy 3: Shared Constants / Config Match             |
|  confidence: deterministic                               |
|  fetch(API_ROUTES.GET_USER) ↔ app.get(API_ROUTES.GET_USER)|
+───────────────────────────┬──────────────────────────────+
                            | unmatched callers
                            v
+──────────────────────────────────────────────────────────+
|  Strategy 4: Pattern Prefix Match                        |
|  confidence: heuristic                                   |
|  Multiple candidates, ranked by specificity              |
+───────────────────────────┬──────────────────────────────+
                            | ambiguous callers
                            v
+──────────────────────────────────────────────────────────+
|  Strategy 5: AI Contextual Analysis                      |
|  confidence: contextual                                  |
|  LLM reads source code, reasons about intent             |
+───────────────────────────┬──────────────────────────────+
                            | still ambiguous
                            v
+──────────────────────────────────────────────────────────+
|  Strategy 6: Human Confirmation                          |
|  confidence: confirmed                                   |
|  Developer selects the correct match                     |
+──────────────────────────────────────────────────────────+
```

### 2.1 Strategy 1: Exact URL + Method Match

The simplest case. The client uses a string literal URL that exactly matches a route pattern with no parameters.

```
Client:   fetch('/api/users', { method: 'POST' })
Server:   app.post('/api/users', createUserHandler)

URL:      '/api/users' === '/api/users'     ✓
Method:   'POST' === 'POST'                 ✓
Result:   deterministic, exact-url match
```

This works when:
- The URL is a string literal (not a template)
- The route pattern has no parameters
- The method is statically known

No ambiguity is possible. This is the gold standard.

### 2.2 Strategy 2: Segment-Count Match

When the URL is a template literal, the fetch visitor knows both the static prefix and the number of dynamic interpolations (template spans). This is enough to disambiguate in most cases.

```
Client:   fetch(`/api/users/${id}`)
          → prefix: '/api/users/'
          → spans: 1
          → total segments: 3 ('/api', '/users', '/${id}')

Server candidates:
  app.get('/api/users/:id')
          → segments: 3 ('/api', '/users', '/:id')
          → params after shared prefix: 1
          → MATCH (segment count matches span count)

  app.get('/api/users/:userId/posts')
          → segments: 4 ('/api', '/users', '/:userId', '/posts')
          → params after shared prefix: 1 param + 1 literal
          → REJECT (total segments don't match)
```

The key insight: a template literal with N interpolations produces a URL with exactly N dynamic segments. A route with M segments after the shared prefix is only compatible if the segment structure is possible given N dynamic values.

```
Template structure analysis:

  fetch(`/api/users/${id}`)
  Template parts:  ['/api/users/', '']
  Spans:           [id]
  Reconstructed:   /api/users/ + <1 value> + (nothing)
  Total segments:  3 (api, users, <value>)

  fetch(`/api/users/${userId}/posts`)
  Template parts:  ['/api/users/', '/posts']
  Spans:           [userId]
  Reconstructed:   /api/users/ + <1 value> + /posts
  Total segments:  4 (api, users, <value>, posts)
```

By emitting the full template structure (not just the prefix), the stitcher can distinguish these two cases deterministically:

```
Client:   fetch(`/api/users/${id}`)
          → parts: ['/api/users/', ''], spans: 1

Server:   GET /api/users/:id           → 3 segments → matches 3
          GET /api/users/:userId/posts  → 4 segments → doesn't match 3

Result:   deterministic, segment-count match → GET /api/users/:id
```

### 2.3 Strategy 3: Shared Constants / Config Match

Some projects define API routes as constants shared between client and server:

```typescript
// shared/routes.ts (imported by both client and server)
export const API_ROUTES = {
    LIST_USERS: '/api/users',
    GET_USER: '/api/users/:id',
    CREATE_USER: '/api/users',
};

// Client
fetch(API_ROUTES.GET_USER.replace(':id', String(userId)))

// Server
app.get(API_ROUTES.GET_USER, getUserHandler)
```

Detection:
1. Both the fetch visitor and Express visitor see a non-literal URL — a property access on `API_ROUTES`
2. Resolve the identifier to its definition in `shared/routes.ts`
3. The constant value is a string literal — extract it
4. Both sides reference the same constant — this is a deterministic match even though the URL at the call site was dynamic

```
Client:   fetch(API_ROUTES.GET_USER.replace(':id', userId))
          → resolves to constant: '/api/users/:id'

Server:   app.get(API_ROUTES.GET_USER, getUserHandler)
          → resolves to constant: '/api/users/:id'

Same constant → deterministic match
```

This requires the visitors to follow identifier resolution to string constants, which is a natural extension of the existing template literal analysis.

### 2.4 Strategy 4: Pattern Prefix Match

When strategies 1-3 don't produce a unique match, fall back to prefix matching. This is the current v1 behavior, but now explicitly labeled as heuristic.

```
Client:   fetch(`/api/users/${userId}/posts`)
          → prefix: '/api/users/'
          → spans: 2 (userId and the implicit join with '/posts')

Wait — actually this template has parts: ['/api/users/', '/posts']
and spans: [userId]. So span count is 1, total segments is 4.

Server candidates:
  GET /api/users/:userId/posts   → 4 segments → matches!
  GET /api/users/:id             → 3 segments → doesn't match

Strategy 2 would resolve this. But if the template were truly ambiguous
(e.g., computed URL), pattern prefix matching is the fallback:

Client:   fetch(buildUrl('users', userId, 'posts'))
          → urlLiteral: null, confidence: dynamic

Server candidates matching GET method:
  GET /api/users
  GET /api/users/:id
  GET /api/users/:userId/posts

Result: ambiguous, passed to Strategy 5 or 6
```

When multiple candidates remain at the same specificity, all are emitted with `confidence: "heuristic"` and the stitching tools surface them for review.

### 2.5 Strategy 5: AI Contextual Analysis

For ambiguous matches, an LLM can read the source code on both sides and reason about intent:

```
Prompt to AI:

  The fetch call at PostList.tsx:14 inside the PostList component
  calls: fetch(`/api/users/${userId}/posts`)

  It could match either:
    A) GET /api/users/:id         (getUserHandler → reads User table)
    B) GET /api/users/:userId/posts (listPostsHandler → reads Post table)

  Here is the source code of the fetch call site:
  [evidence snippet from PostList.tsx]

  Here is the source code of endpoint A's handler:
  [evidence snippet from getUserHandler]

  Here is the source code of endpoint B's handler:
  [evidence snippet from listPostsHandler]

  Which endpoint does this fetch call target?

AI reasoning:
  The component is called PostList and takes a userId prop.
  The fetch URL includes '/posts' as a literal suffix.
  The handler for option B is listPostsHandler which reads the Post table.
  This clearly targets endpoint B.

Result: contextual match → GET /api/users/:userId/posts
```

The AI uses the evidence system (#96) and `get_source_file` tool to read actual code. Its answer is recorded as `confirmedBy: "ai"` and can be overridden by a human.

### 2.6 Strategy 6: Human Confirmation

The final authority. The stitching tools surface ambiguous matches:

```
suggest_stitches() returns:
{
  callerId: "ClientSideAPICaller:...",
  callerDescription: "PostList.tsx:14 — fetch(`/api/users/${userId}/posts`)",
  candidates: [
    {
      endpointId: "APIEndpoint:...",
      description: "GET /api/users/:id → getUserHandler → reads User",
      strategy: "pattern",
      confidence: "heuristic"
    },
    {
      endpointId: "APIEndpoint:...",
      description: "GET /api/users/:userId/posts → listPostsHandler → reads Post",
      strategy: "pattern",
      confidence: "heuristic"
    }
  ],
  aiSuggestion: {
    endpointId: "APIEndpoint:...(posts)",
    reasoning: "Component is PostList, URL ends with /posts literal"
  }
}

Human calls:
  confirm_stitch(callerId, endpointId_for_posts, "PostList fetches posts, not user details")

Result: confirmed match, persisted permanently
```

## 3. Same Repository: Both Graphs from One Analysis

The simplest case. Client code and server code live in the same repo (e.g., a monorepo or a full-stack app).

```
adorable analyze ./my-fullstack-app --output graph.db

Phase 1: Per-file AST walk (all files)
  ├── src/components/*.tsx  → client graph nodes
  ├── src/server.ts         → server graph nodes (endpoints)
  ├── src/services/*.ts     → server graph nodes (services, DB)
  └── prisma/schema.prisma  → database schema

Phase 2: Cross-file resolution
  ├── Client: resolve imported hooks, handlers
  ├── Server: resolve imported handlers, services
  └── (no cross-boundary resolution — that's stitching)

Phase 3: Stitching (within one graph.db)
  ├── All ClientSideAPICaller nodes are in graph.db
  ├── All APIEndpoint nodes are in graph.db
  └── Run cascade: exact → segment-count → pattern → AI → human
```

Both graphs share the same `graph.db`. The stitching tools query the same store for callers and endpoints.

```
+--------------------------+
|        graph.db          |
|                          |
|  CLIENT GRAPH            |
|  ┌──────────────────┐    |
|  │ ClientSideProcess│    |
|  │ FunctionDefinition│   |
|  │ ClientSideAPICaller│  |       suggest_stitches()
|  └──────────────────┘    |       confirm_stitch()
|          ↕ stitch         |       reject_stitch()
|  ┌──────────────────┐    |
|  │ APIEndpoint       │   |
|  │ FunctionDefinition│   |
|  │ DatabaseInteraction│  |
|  └──────────────────┘    |
|  SERVER GRAPH            |
|                          |
+--------------------------+
```

## 4. Multiple Repositories: One Graph Per Repo

Real-world systems often split client and server into separate repositories:

```
my-org/
  ├── frontend-app/          ← React SPA
  ├── user-service/          ← Express API for users
  ├── post-service/          ← Express API for posts
  └── shared-types/          ← TypeScript types (optional)
```

The frontend calls both backend services. Each service has its own database. The question is: how do we build and stitch graphs across repositories?

### 4.1 One Graph Per Repository

Each repository is analyzed independently, producing its own `graph.db`:

```
adorable analyze ./frontend-app    --output frontend.db
adorable analyze ./user-service    --output user-service.db
adorable analyze ./post-service    --output post-service.db
```

Each database contains a self-contained graph:

```
frontend.db:                    user-service.db:              post-service.db:
┌──────────────────┐            ┌──────────────────┐          ┌──────────────────┐
│ ClientSideProcess│            │ APIEndpoint       │          │ APIEndpoint       │
│ - onClick        │            │ - GET /api/users  │          │ - GET /api/posts  │
│ - useEffect      │            │ - POST /api/users │          │ - POST /api/posts │
│                  │            │ - GET /api/users/ │          │ - DELETE /api/    │
│ ClientSideAPI    │            │   :id             │          │   posts/:id       │
│ Caller           │            │                   │          │                   │
│ - GET /api/users │            │ FunctionDefinition│          │ FunctionDefinition│
│ - POST /api/users│            │ - listUsers       │          │ - listPosts       │
│ - GET /api/posts │            │ - createUser      │          │ - createPost      │
│ - POST /api/posts│            │ - getUser         │          │ - deletePost      │
│                  │            │                   │          │                   │
│ (no endpoints)   │            │ DatabaseInteract. │          │ DatabaseInteract. │
│ (no DB)          │            │ - User table      │          │ - Post table      │
└──────────────────┘            └──────────────────┘          └──────────────────┘
```

### 4.2 The Project Concept

A **project** groups multiple repositories (R-11.4). The stitching layer operates at the project level, not the repository level:

```
adorable project create my-system
adorable project add-repo my-system ./frontend-app    --label frontend
adorable project add-repo my-system ./user-service    --label user-api
adorable project add-repo my-system ./post-service    --label post-api
adorable project analyze my-system
adorable project stitch my-system
```

The project-level analysis:
1. Analyzes each repository independently (parallel)
2. Merges the graphs into a unified project graph
3. Runs stitching across all repositories

```
                    +─────────────────────────+
                    |     project.db          |
                    |                         |
                    |  ┌───────────────────┐  |
                    |  │ frontend.db       │  |
                    |  │ (client graph)    │  |
                    |  └────────┬──────────┘  |
                    |           │              |
                    |      stitching           |
                    |       layer              |
                    |      ╱    ╲              |
                    |  ┌──┴────┐ ┌────┴─────┐ |
                    |  │user-  │ │post-     │ |
                    |  │service│ │service   │ |
                    |  │.db    │ │.db       │ |
                    |  │(server│ │(server   │ |
                    |  │ graph)│ │ graph)   │ |
                    |  └───────┘ └──────────┘ |
                    +─────────────────────────+
```

### 4.3 Cross-Repo Stitching

The stitching cascade works the same way, but now callers and endpoints come from different repositories. The key additional challenge is **base URL resolution**.

Within a single repo, the frontend calls `/api/users` and the server declares `app.get('/api/users')` — the paths are identical. Across repos, the frontend might use a full URL or a configured base:

```typescript
// Frontend (frontend-app/)
const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3000';
fetch(`${API_BASE}/api/users`);

// Or with an HTTP client
const userApi = axios.create({ baseURL: 'http://user-service:3000' });
userApi.get('/api/users');

// Or with a proxy (Next.js, Vite)
// vite.config.ts: proxy: { '/api/users': 'http://localhost:3001' }
fetch('/api/users');  // proxied to user-service
```

The server declares:
```typescript
// Backend (user-service/)
app.get('/api/users', listUsersHandler);
```

The paths match (`/api/users`), but the frontend might have a base URL prefix or a proxy rewrite. The stitcher needs to handle this.

### 4.4 Base URL and Proxy Resolution

```
Scenario 1: No base URL (same-origin or proxy)
───────────────────────────────────────────────
Client:   fetch('/api/users')
Server:   app.get('/api/users')
Match:    direct — paths are identical

Scenario 2: Base URL prefix
───────────────────────────
Client:   fetch('http://user-service:3000/api/users')
Server:   app.get('/api/users')
Match:    strip the origin (scheme + host + port), match on path

Scenario 3: API client with baseURL
────────────────────────────────────
Client:   userApi.get('/users')  where userApi.baseURL = '/api'
Server:   app.get('/api/users')
Match:    compose baseURL + path = '/api/users', then match

Scenario 4: Proxy rewrite
─────────────────────────
Client:   fetch('/user-api/users')
Proxy:    /user-api/* → http://user-service:3000/api/*
Server:   app.get('/api/users')
Match:    apply proxy rewrite rule, then match
```

For cross-repo stitching, the project configuration needs to declare how the frontend reaches each backend:

```json
{
  "project": "my-system",
  "repositories": [
    { "path": "./frontend-app", "label": "frontend" },
    { "path": "./user-service", "label": "user-api" },
    { "path": "./post-service", "label": "post-api" }
  ],
  "routing": [
    {
      "from": "frontend",
      "to": "user-api",
      "match": { "pathPrefix": "/api/users" },
      "rewrite": null
    },
    {
      "from": "frontend",
      "to": "post-api",
      "match": { "pathPrefix": "/api/posts" },
      "rewrite": null
    }
  ]
}
```

When no routing config is provided, the stitcher matches callers against endpoints from all repos by URL + method. When routing config is provided, it narrows the search:

```
Without routing config:
  fetch('/api/users') matches against:
    user-service: GET /api/users     ✓ (exact)
    post-service: (no match)

  This works when paths are globally unique.

With routing config:
  fetch('/api/users/123') is routed to user-api repo.
  Only endpoints in user-service.db are considered.
  No ambiguity with post-service even if it had similar paths.
```

### 4.5 Cross-Repo Stitching Diagram

```
FRONTEND REPO                                    USER-SERVICE REPO
(frontend.db)                                    (user-service.db)

+----------+                                     +-------------------+
| useEffect|                                     | GET /api/users    |
| UserList |                                     | listUsersHandler  |
|          |                                     | → reads User table|
| fetch()  | ─ ─ stitch (exact) ─ ─ ─ ─ ─ ─ ─> |                   |
| GET      |                                     +-------------------+
| /api/    |
| users    |                                     +-------------------+
+----------+                                     | POST /api/users   |
                                                 | createUserHandler |
+----------+                                     | → writes User     |
| onSubmit | ─ ─ stitch (exact) ─ ─ ─ ─ ─ ─ ─> |   table            |
| Create   |                                     +-------------------+
| UserForm |
|          |                                     +-------------------+
| fetch()  |                                     | GET /api/users/:id|
| POST     |                                     | getUserHandler    |
| /api/    |                                     | → reads User table|
| users    |                                     +-------------------+
+----------+

+----------+                                     POST-SERVICE REPO
| useEffect|                                     (post-service.db)
| PostList |
|          |                                     +--------------------+
| fetch()  | ─ ─ stitch (segment-count) ─ ─ ─>  | GET /api/users/    |
| GET      |                                     | :userId/posts      |
| /api/    |                                     | listPostsHandler   |
| users/   |                                     | → reads Post table |
| ${uid}/  |                                     +--------------------+
| posts    |
+----------+
```

## 5. Service-to-Service Calls

In microservice architectures, backends call other backends. The server graph captures these as outbound HTTP calls — the same `ClientSideAPICaller` mechanism but in server code:

```typescript
// post-service/src/services/posts.ts
export async function createPost(userId: number, title: string) {
    // Validate user exists by calling user-service
    const user = await fetch(`http://user-service:3000/api/users/${userId}`);
    if (!user.ok) throw new Error('User not found');

    return prisma.post.create({ data: { title, authorId: userId } });
}
```

This fetch call is in server code, not client code. The fetch visitor detects it regardless of which side it's in. The result is a `ClientSideAPICaller` node in `post-service.db` that needs stitching to an endpoint in `user-service.db`.

```
POST-SERVICE REPO                                USER-SERVICE REPO
(post-service.db)                                (user-service.db)

+-------------------+                            +-------------------+
| POST /api/posts   |                            |                   |
| createPostHandler |                            |                   |
| → calls createPost|                            |                   |
+-------------------+                            |                   |
        |                                        |                   |
   CALLS_FUNCTION                                |                   |
        |                                        |                   |
        v                                        |                   |
+-------------------+                            |                   |
| createPost        |                            |                   |
| posts.ts:3        |                            |                   |
|                   |  fetch GET                 | GET /api/users/:id|
|   fetch(user-svc/ | ─ ─ stitch ─ ─ ─ ─ ─ ─ > | getUserHandler    |
|     api/users/    |                            | → reads User table|
|     ${userId})    |                            |                   |
|                   |                            +-------------------+
|   prisma.post     |
|     .create()     |
|   → writes Post   |
+-------------------+
```

The stitching cascade handles this identically to client-to-server stitching. The project routing config just needs an additional entry:

```json
{
  "routing": [
    { "from": "frontend", "to": "user-api", "match": { "pathPrefix": "/api/users" } },
    { "from": "frontend", "to": "post-api", "match": { "pathPrefix": "/api/posts" } },
    { "from": "post-api", "to": "user-api", "match": { "pathPrefix": "/api/users" } }
  ]
}
```

## 6. The Combined Multi-Repo Flow

After stitching, a single end-to-end flow can span multiple repositories:

```
FRONTEND                  POST-SERVICE               USER-SERVICE

+----------+              +-------------------+
| onClick  |              | POST /api/posts   |
| "Create  |              | createPostHandler |
|  Post"   |              +--------+----------+
+----+-----+                       |
     |                        CALLS_FUNCTION
  TRIGGERS                         |
     |                             v
     v                    +--------+----------+
+----+-----+              | createPost        |
| arrow()  |              |                   |
| :25-30   |              |   fetch(user-svc  |
+----+-----+              |     /api/users/   |                +------------------+
     |                    |     ${userId})    | ─ ─ stitch ─ > | GET /api/users/  |
  MAKES_REQUEST           |                   |                | :id              |
     |                    |   prisma.post     |                | getUserHandler   |
     v                    |     .create()     |                +--------+---------+
+----+-----+              +--------+----------+                         |
| POST     |                       |                               CALLS_FUNCTION
| /api/    |                    WRITES                                  |
| posts    |                       |                                    v
+----------+                       v                            +-------+---------+
     |                    +--------+----------+                 | getUserById     |
  stitched                | Post table        |                 | → prisma.user   |
     |                    +-------------------+                 |   .findUnique() |
     v                                                          +-------+---------+
+----+-----+                                                            |
| POST     |                                                         READS
| /api/    |                                                            |
| posts    |                                                            v
| create   |                                                    +-------+---------+
| Post     |                                                    | User table      |
| Handler  |                                                    +-----------------+
+----------+

This flow spans 3 repos, 2 stitch boundaries, and 2 databases.
```

## 7. Data Model for Multi-Repo Stitching

### 7.1 Repository Identity

Every node already carries a `repository` field (e.g., `"sample-react-express-prisma"`). In a multi-repo project, this field distinguishes which repo each node came from.

### 7.2 Project-Level Graph Store

Two approaches:

**Approach A: Merged database**

Analyze each repo into its own `.db`, then merge into a single `project.db`:

```
adorable project merge \
    --frontend frontend.db \
    --user-api user-service.db \
    --post-api post-service.db \
    --output project.db
```

All nodes coexist in one store. Content-addressed IDs already include the repository name, so there are no collisions. Stitching queries a single store.

Pros: Simple querying, single MCP server, familiar model.
Cons: Stale data if one repo is re-analyzed but the project.db isn't re-merged.

**Approach B: Federated query**

Each repo keeps its own `.db`. The MCP server queries all of them:

```json
{
  "mcpServers": {
    "adorable": {
      "command": "node",
      "args": ["adorable", "serve-project", "--config", "project.json"]
    }
  }
}
```

The `serve-project` command loads all repo databases and presents a unified query interface. Stitching edges are stored in a separate `stitches.db`.

Pros: Each repo can be re-analyzed independently. No stale data.
Cons: More complex implementation. Cross-store queries.

**Recommendation:** Start with Approach A (merged database) for simplicity. The content-addressed ID system makes merging trivial — it's just inserting all nodes and edges from each repo's database into the project database. Duplicates (same ID) are handled by the existing upsert logic.

### 7.3 Stitch Edge Schema

```json
{
  "edgeType": "RESOLVES_TO_ENDPOINT",
  "from": "ClientSideAPICaller:abc123",
  "to": "APIEndpoint:def456",
  "fromRepository": "frontend-app",
  "toRepository": "user-service",
  "confirmedBy": "ai",
  "confirmedAt": "2026-04-10T...",
  "strategy": "segment-count",
  "confidence": "deterministic",
  "reason": "1 template span matches 1 route param after shared prefix /api/users/"
}
```

The `fromRepository` and `toRepository` fields make the cross-repo nature explicit. The audit trail (`confirmedBy`, `strategy`, `reason`) satisfies R-5.4.

## 8. API Contract Discovery

In multi-repo architectures, a valuable additional signal is the API contract — OpenAPI specs, GraphQL schemas, tRPC routers, or shared TypeScript types.

```
Scenario: OpenAPI spec

  user-service publishes:
    openapi.yaml:
      paths:
        /api/users:
          get: { operationId: listUsers, ... }
          post: { operationId: createUser, ... }
        /api/users/{id}:
          get: { operationId: getUser, ... }

  frontend-app generates a client from the spec:
    import { listUsers, getUser } from './generated/user-api';

  The generated client function names match operationIds.
  The operationIds match handler function names.
```

If the project has an API spec, the stitcher can use it as a high-confidence source:

```
Client:   listUsers() [generated from openapi.yaml]
          → GET /api/users (from spec)

Server:   app.get('/api/users', listUsersHandler)
          → operationId: listUsers (from spec)

Match:    deterministic — both reference the same operationId
```

This is a future enhancement. The initial implementation doesn't require API specs but can benefit from them when available.

## 9. What Happens When Endpoints Move Between Repos

A common scenario in evolving architectures: a monolith is split into microservices, or services are consolidated.

```
Before: All endpoints in monolith/
  monolith/
    app.get('/api/users', ...)
    app.get('/api/posts', ...)

After: Split into services
  user-service/
    app.get('/api/users', ...)
  post-service/
    app.get('/api/posts', ...)
```

The client code doesn't change — it still calls `/api/users` and `/api/posts`. But the stitching targets move from one repo to another.

With the project-level stitching model:
1. Remove `monolith` from the project
2. Add `user-service` and `post-service`
3. Re-analyze
4. Previously confirmed stitches are invalidated (the endpoint IDs changed because the repository field changed)
5. New stitches are proposed — most auto-resolve via exact URL match
6. The few ambiguous cases are re-confirmed

The confirmed stitch persistence (R-5.6) recognizes that the endpoint moved by comparing the route pattern + method. It can suggest: _"POST /api/users moved from monolith to user-service. Re-confirm stitch?"_

## 10. Summary: The Full Picture

```
+─────────────────────────────────────────────────────────────────────+
|                          PROJECT                                    |
|                                                                     |
|  +──────────────+    +──────────────+    +──────────────+           |
|  | frontend.db  |    | user-svc.db  |    | post-svc.db  |           |
|  |              |    |              |    |              |           |
|  | CLIENT GRAPH |    | SERVER GRAPH |    | SERVER GRAPH |           |
|  | - processes  |    | - endpoints  |    | - endpoints  |           |
|  | - callbacks  |    | - handlers   |    | - handlers   |           |
|  | - API callers|    | - services   |    | - services   |           |
|  |              |    | - DB ops     |    | - DB ops     |           |
|  |              |    | - User table |    | - Post table |           |
|  +──────+───────+    +──────+───────+    +──────+───────+           |
|         |                   |                   |                   |
|         +───────────────────+───────────────────+                   |
|                             |                                       |
|                    +────────+─────────+                              |
|                    |  STITCHING LAYER |                              |
|                    |                  |                              |
|                    |  1. exact match  |                              |
|                    |  2. segment-count|                              |
|                    |  3. shared const |                              |
|                    |  4. pattern      |                              |
|                    |  5. AI analysis  |                              |
|                    |  6. human confirm|                              |
|                    |                  |                              |
|                    |  routing config  |                              |
|                    |  (which repo     |                              |
|                    |   serves which   |                              |
|                    |   path prefix)   |                              |
|                    +────────+─────────+                              |
|                             |                                       |
|                    +────────+─────────+                              |
|                    | COMBINED GRAPH   |                              |
|                    | (project.db)     |                              |
|                    |                  |                              |
|                    | End-to-end flows |                              |
|                    | spanning repos   |                              |
|                    | with provenance  |                              |
|                    +──────────────────+                              |
|                                                                     |
+─────────────────────────────────────────────────────────────────────+

Each graph is built independently (Phase 1 + 2 per repo).
Stitching happens at the project level (Phase 3).
The combined graph is the union + confirmed stitch edges.
```
