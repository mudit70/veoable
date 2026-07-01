# Building a Server-Side Call Graph

## 1. Goal

Build a complete call graph of the server-side code such that for any API endpoint, we can trace exactly which functions execute, which database operations are performed, what data is read or written, and what response is returned — producing a self-contained "what happens when this endpoint is called" answer without needing the client graph.

## 2. How the Server Side Differs from the Client Side

The client graph starts from UI interactions and traces to outbound HTTP calls. The server graph starts from inbound HTTP calls and traces to database operations. But the fundamental approach — per-file AST walk, cross-file resolution via imports, query-time BFS — is the same.

Key differences:

| Aspect | Client Side | Server Side |
|--------|------------|-------------|
| **Entry points** | UI interactions (onClick, useEffect) | API endpoints (app.get, router.post) |
| **Exit points** | Outbound HTTP calls (fetch) | Database operations (prisma.user.create) |
| **Framework patterns** | JSX attributes, hooks, component composition | Route declarations, middleware chains, decorators |
| **Cross-boundary** | Request goes out | Request comes in |
| **Schema source** | None (request shape is in the fetch call) | Prisma schema, migrations, type definitions |

## 3. High-Level Approach

Same three-phase architecture as the client graph:

```
Phase 1                    Phase 2                    Phase 3
Per-File AST Walk          Cross-File Resolution      Endpoint-Rooted Tracing
(embarrassingly parallel)  (needs global view)        (query-time)

+----------+               +----------+               +------------+
| server.ts| ──> endpoints | import   |               | GET /users |
|          |     handlers   | graph    |               |     |      |
+----------+     imports    |          |               |     v      |
                            | resolve  |               | listUsers  |
+----------+               | handler  |               |     |      |
| users.ts | ──> functions  | ids      |──> merged ──>|     v      |
|          |     db calls   | cross-   |    graph      | prisma     |
+----------+     imports    | file     |               | .findMany()|
                            | calls    |               |     |      |
+----------+               +----------+               |     v      |
| prisma.ts| ──> db client                             | User table |
|          |     export                                +------------+
+----------+
```

## 4. Phase 1: Per-File AST Walk

### 4.1 What We Extract From Each File

```
Source File
  |
  +-- Function Definitions (all of them)
  |     - named function declarations (handlers, services, utilities)
  |     - arrow functions bound to variables
  |     - class methods (for NestJS-style controllers)
  |     - middleware functions
  |
  +-- API Endpoints (inbound routes)
  |     - Express: app.get('/path', handler), router.post(...)
  |     - Fastify: fastify.get('/path', { handler })  (future)
  |     - NestJS: @Get('/path') decorators  (future)
  |
  +-- Database Interactions (data layer)
  |     - Prisma: prisma.user.findMany(), prisma.$queryRaw
  |     - SQL: db.query('SELECT ...')  (future)
  |     - Mongoose: User.find()  (future)
  |
  +-- Intra-File Call Edges
  |     - handler calls service function (both in same file)
  |
  +-- Import/Export Declarations
  |     - imports from other project files
  |     - imports from node_modules (framework detection)
  |
  +-- Handler Resolution
        - which endpoint maps to which handler function
```

### 4.2 The Anatomy of a Server File

Server-side code typically has a layered structure. Each layer lives in different files:

```
ROUTE LAYER (server.ts, routes/*.ts)
──────────────────────────────────────
Declares endpoints, maps them to handlers.
Imports handlers from the handler/controller layer.

  app.get('/api/users', listUsersHandler);
  app.post('/api/users', createUserHandler);
  app.get('/api/users/:id', getUserHandler);


HANDLER LAYER (handlers/*.ts, controllers/*.ts)
──────────────────────────────────────────────────
Receives request, validates input, calls service layer,
formats response. May be in the same file as routes
(small apps) or separate (large apps).

  export async function listUsersHandler(req, res) {
      const users = await listUsers();
      res.json(users);
  }


SERVICE LAYER (services/*.ts)
──────────────────────────────
Business logic. Calls the data layer.
May call other services.

  export async function listUsers() {
      return prisma.user.findMany();
  }


DATA LAYER (lib/prisma.ts, db/*.ts)
──────────────────────────────────────
Database client, connection management.
Usually a singleton export.

  export const prisma = new PrismaClient();
```

### 4.3 The Single-Walk Algorithm (Server-Focused)

The walker is the same structural extractor from the client graph (`walkForExtraction`), but the framework visitors dispatch differently:

```
walkNode(node, state):
    pushed = null

    // 1. Function-shaped declarations (same as client)
    if node is FunctionDeclaration/ArrowFunction/Method/etc.:
        fnDef = buildFunctionDefinition(node)
        emit(fnDef)
        emit(DEFINED_IN: fnDef → sourceFile)
        pushed = fnDef

    // 2. Express route declarations (framework-express visitor)
    if node is CallExpression matching app.<method>('/path', handler):
        endpoint = buildAPIEndpoint(node)
        emit(endpoint)

        handlerFnId = resolveHandler(node)  // see 4.4
        if handlerFnId:
            emit(HANDLES: endpoint → handlerFnId)
        else:
            recordPendingHandler(endpoint, handlerExpr)

    // 3. Prisma CRUD calls (framework-prisma visitor)
    if node is CallExpression matching prisma.<model>.<method>():
        interaction = buildDatabaseInteraction(node)
        emit(interaction)
        emit(PERFORMS: state.enclosingFunction → interaction)

        table = resolveTable(model, method)
        if method is read-type:
            emit(READS: interaction → table)
        else:
            emit(WRITES: interaction → table)

    // 4. Intra-file function calls (same as client)
    if node is CallExpression and callee resolves to same-file function:
        emit(CALLS_FUNCTION: state.enclosingFunction → targetFnId)

    // 5-8. Push/recurse/pop (same as client)
    ...
```

### 4.4 Resolving Route Handlers

The handler argument in a route declaration can take several forms:

```
Form 1: Same-file named function
─────────────────────────────────
export async function listUsersHandler(req, res) { ... }
app.get('/api/users', listUsersHandler);

  Resolution: Identifier "listUsersHandler" → symbol → same-file declaration.
  The FunctionDefinition was already emitted by the structural walk.
  Emit HANDLES edge directly.

  +-------------+  HANDLES  +------------------+
  | GET         |─────────>| listUsersHandler |
  | /api/users  |          | server.ts:10     |
  +-------------+          +------------------+


Form 2: Imported named function
────────────────────────────────
import { listUsersHandler } from './handlers/users';
app.get('/api/users', listUsersHandler);

  Resolution: Identifier → ImportSpecifier.
  Cannot resolve to FunctionDefinition in Phase 1 because
  we need the target file's sourceFileId (requires rootDir).

  Record as pending. Phase 2 resolves it.

  +-------------+  HANDLES (pending)  +------------------+
  | GET         |─ ─ ─ ─ ─ ─ ─ ─ ─ >| listUsersHandler |
  | /api/users  |                     | (imported from   |
  +-------------+                     |  ./handlers/users|
                                      +------------------+


Form 3: Inline arrow function
─────────────────────────────
app.get('/api/users', async (req, res) => {
    const users = await listUsers();
    res.json(users);
});

  Resolution: The handler IS the arrow function.
  Emit FunctionDefinition for the inline arrow.
  Emit HANDLES edge directly.

  +-------------+  HANDLES  +-----------------+  CALLS_FUNCTION  +----------+
  | GET         |─────────>| inline$handler  |────────────────>| listUsers|
  | /api/users  |          | server.ts:5-8   |                 |          |
  +-------------+          +-----------------+                 +----------+


Form 4: Method on a controller object
──────────────────────────────────────
const userController = {
    list: async (req, res) => { ... },
    create: async (req, res) => { ... },
};
app.get('/api/users', userController.list);

  Resolution: PropertyAccessExpression → resolve object → find method.
  Requires type analysis or structural matching.

  Confidence: "heuristic" if resolved by name, "exact" if by type.


Form 5: Class method with decorator (NestJS pattern)
────────────────────────────────────────────────────
@Controller('users')
export class UsersController {
    @Get()
    async findAll() { ... }

    @Get(':id')
    async findOne(@Param('id') id: string) { ... }
}

  Resolution: Decorator-based. The route is derived from:
  - @Controller('users') prefix
  - @Get() / @Get(':id') method decorator
  - Method name is the handler.

  This requires a NestJS-specific visitor (future plugin).
  The per-file walk detects decorators and builds the endpoint
  + handler in one step (no separate HANDLES edge needed since
  the method IS the handler).
```

### 4.5 Middleware Chains

Express routes often have middleware between the path and the handler:

```typescript
app.get('/api/users', authenticate, authorize('admin'), listUsersHandler);
```

The handler is the **last** argument. Middleware functions are everything in between.

```
+-------------+                +----------+
| GET         |── MIDDLEWARE ──| auth     |
| /api/users  |                +----+-----+
+-------------+                     |
      |                        MIDDLEWARE
      |                             |
      |                        +----+-----+
      |                        | authorize|
      |                        +----+-----+
      |                             |
      +── HANDLES ──────────────────+───> listUsersHandler
```

For the call graph, we care primarily about the handler (the function that produces the response). Middleware is relevant for understanding authentication, validation, and error handling — but it's a separate concern. The initial implementation emits the HANDLES edge to the last argument and records middleware as metadata on the endpoint.

### 4.6 Router Composition

Express apps often compose routes via sub-routers:

```typescript
// routes/users.ts
const router = express.Router();
router.get('/', listUsersHandler);        // relative path
router.get('/:id', getUserHandler);
export default router;

// server.ts
import userRouter from './routes/users';
app.use('/api/users', userRouter);        // mount prefix
```

The actual endpoint paths are `/api/users/` and `/api/users/:id` — composed from the mount prefix and the router-relative path. Today the Express visitor emits routes as declared on whichever router owns them (just `/` and `/:id`). Resolving the full path requires:

1. Detecting `app.use('/prefix', router)` calls
2. Linking the router variable to its definition
3. Prepending the prefix to all routes on that router

```
Phase 1 (per file):

  routes/users.ts:
    router.get('/', listUsersHandler)      → endpoint: GET /
    router.get('/:id', getUserHandler)     → endpoint: GET /:id

  server.ts:
    app.use('/api/users', userRouter)      → mount: /api/users → userRouter

Phase 2 (cross-file):

    Compose: mount prefix + router path
    GET /api/users + /         → GET /api/users
    GET /api/users + /:id     → GET /api/users/:id
```

This is a Phase 2 operation because it requires cross-file knowledge (which router is mounted where).

### 4.7 Per-File Output

```json
{
  "sourceFile": { "id": "SourceFile:...", "filePath": "src/server.ts" },
  "functions": [
    { "id": "FunctionDefinition:...", "name": "listUsersHandler", "sourceLine": 10 },
    { "id": "FunctionDefinition:...", "name": "getUserHandler", "sourceLine": 15 }
  ],
  "endpoints": [
    { "id": "APIEndpoint:...", "method": "GET", "route": "/api/users" },
    { "id": "APIEndpoint:...", "method": "GET", "route": "/api/users/:id" }
  ],
  "databaseInteractions": [],
  "intraFileEdges": [
    { "type": "HANDLES", "from": "APIEndpoint:...", "to": "FunctionDefinition:..." },
    { "type": "CALLS_FUNCTION", "from": "FunctionDefinition:...(handler)", "to": "FunctionDefinition:...(service)" }
  ],
  "imports": [
    { "from": "SourceFile:...", "to": "SourceFile:...(users.ts)", "symbols": ["listUsers", "getUserById"] }
  ],
  "pendingCrossFileEdges": [
    { "type": "CALLS_FUNCTION", "from": "FunctionDefinition:...(handler)", "toSymbol": "listUsers", "importedFrom": "./services/users" }
  ],
  "pendingHandlers": [],
  "routerMounts": []
}
```

## 5. Phase 2: Cross-File Resolution

### 5.1 Building the Import Graph

Same as the client side — merge all per-file import declarations into a directed graph:

```
server.ts ──imports listUsers, getUserById──> services/users.ts ──imports prisma──> lib/prisma.ts
    |                                             |
    +──imports createPost───────────> services/posts.ts ──imports prisma──> lib/prisma.ts
```

### 5.2 Resolving Cross-File Handler IDs

The most important cross-file resolution for the server graph. When the route declaration imports its handler:

```
resolveHandlerIds(pendingHandlers, importGraph, allFiles):
    for pending in pendingHandlers:
        // Follow the import chain
        targetFileId = importGraph.resolve(
            from: pending.sourceFileId,
            symbol: pending.handlerSymbol
        )

        // Find the function in the target file
        targetFile = allFiles[targetFileId]
        fnDef = targetFile.functions.find(
            name: pending.handlerSymbol,
            isExported: true
        )

        if fnDef:
            // Update the endpoint's handlerFunctionId
            endpoint = getNode(pending.endpointId)
            emit(HANDLES: endpoint → fnDef)
        else:
            // Handler not found — maybe re-exported or dynamic
            recordUnresolved(pending)
```

### 5.3 Resolving Cross-File Call Edges

When a handler calls a service function from another file:

```
server.ts:
  export async function listUsersHandler(_req, res) {
      const users = await listUsers();    // ← imported from ./services/users
      res.json(users);
  }

services/users.ts:
  export async function listUsers() {
      return prisma.user.findMany();      // ← imported from ../lib/prisma
  }
```

Resolution follows the same import graph traversal as the client side:

```
Phase 1:
  server.ts emits:
    FunctionDefinition: listUsersHandler
    pending CALLS_FUNCTION: listUsersHandler → "listUsers" (imported)

  services/users.ts emits:
    FunctionDefinition: listUsers
    FunctionDefinition: getUserById
    DatabaseInteraction: prisma.user.findMany()
    CALLS_FUNCTION: listUsers → prisma.user.findMany (intra-file via Prisma visitor)

Phase 2:
  Resolves: listUsersHandler → listUsers (cross-file CALLS_FUNCTION)

Merged graph:
  +------------------+   CALLS_FUNCTION   +----------+   PERFORMS   +----------------+
  | listUsersHandler |──────────────────>| listUsers|────────────>| prisma.user    |
  | server.ts:10     |   (cross-file)    | users:3  |             | .findMany()    |
  +------------------+                   +----------+             +-------+--------+
                                                                          |
                                                                     READS|
                                                                          v
                                                                  +-------+--------+
                                                                  | User table     |
                                                                  +----------------+
```

### 5.4 Resolving Router Composition

```
resolveRouterMounts(mounts, importGraph, allFiles):
    for mount in mounts:
        // mount = { prefix: '/api/users', routerSymbol: 'userRouter', sourceFileId: '...' }

        // Resolve the router to its source file
        targetFileId = importGraph.resolve(
            from: mount.sourceFileId,
            symbol: mount.routerSymbol
        )

        // Find all endpoints in that file declared on 'router'
        targetFile = allFiles[targetFileId]
        routerEndpoints = targetFile.endpoints.filter(
            framework: 'express',
            receiver: 'router'
        )

        // Compose paths
        for endpoint in routerEndpoints:
            composedRoute = mount.prefix + endpoint.routePattern
            // Update or re-emit the endpoint with the full path
            emit(updated endpoint with routePattern: composedRoute)
```

### 5.5 Cross-File Resolution Diagram

```
PHASE 1 OUTPUT (per file):                     PHASE 2 OUTPUT (merged):

server.ts:                                     +-------------+
  APIEndpoint: GET /api/users                  | GET         |
  APIEndpoint: GET /api/users/:id              | /api/users  |
  FunctionDef: listUsersHandler                +------+------+
  FunctionDef: getUserHandler                         |
  HANDLES: GET /api/users → listUsersHandler       HANDLES
  pending: listUsersHandler calls listUsers           |
  pending: getUserHandler calls getUserById            v
                                               +------+----------+   CALLS_FUNCTION   +----------+
services/users.ts:                             | listUsersHandler|─────────────────>| listUsers|
  FunctionDef: listUsers                       | server.ts:10    |   (resolved      | users:3  |
  FunctionDef: getUserById                     +-----------------+    cross-file)    +----+-----+
  DatabaseInteraction: prisma.user.findMany                                              |
  DatabaseInteraction: prisma.user.findUnique                                        PERFORMS
  PERFORMS: listUsers → findMany                                                         |
  PERFORMS: getUserById → findUnique                                                     v
  READS: findMany → User table                                                    +-----+--------+
  READS: findUnique → User table                                                   | prisma.user  |
                                                                                   | .findMany()  |
lib/prisma.ts:                                                                     +-----+--------+
  export: prisma (PrismaClient)                                                          |
                                                                                      READS
                                                                                         |
                                                                                         v
                                                                                   +-----+--------+
                                                                                   | User table   |
                                                                                   +--------------+
```

## 6. Phase 3: Endpoint-Rooted Tracing (Query Time)

### 6.1 The Query

Given an `APIEndpoint`, find all database operations it performs, which tables it reads/writes, and the complete function call chain from handler to data layer.

### 6.2 The Algorithm

```
traceFromEndpoint(endpointId, graph, maxDepth=10):
    // 1. Find the handler via HANDLES edge
    handlesEdges = graph.findEdges(from: endpointId, type: HANDLES)
    if none:
        return { completeness: "endpoint-only", hops: [] }

    handlerFnId = handlesEdges[0].to

    // 2. BFS from the handler through CALLS_FUNCTION edges
    visited = Set()
    frontier = [handlerFnId]
    reachableFunctions = Set([handlerFnId])
    callChain = []    // ordered list of (caller, callee) pairs
    depth = 0

    while frontier is not empty AND depth < maxDepth:
        nextFrontier = []
        for fnId in frontier:
            if fnId in visited: continue
            visited.add(fnId)

            callEdges = graph.findEdges(from: fnId, type: CALLS_FUNCTION)
            for edge in callEdges:
                callChain.push({ from: fnId, to: edge.to, depth })
                if edge.to not in visited:
                    nextFrontier.push(edge.to)
                    reachableFunctions.add(edge.to)

        frontier = nextFrontier
        depth += 1

    // 3. Find all database interactions performed by reachable functions
    databaseHops = []
    for fnId in reachableFunctions:
        performsEdges = graph.findEdges(from: fnId, type: PERFORMS)
        for edge in performsEdges:
            interaction = graph.getNode(edge.to)

            // Follow READS/WRITES edges to find target tables
            readsEdges = graph.findEdges(from: interaction.id, type: READS)
            writesEdges = graph.findEdges(from: interaction.id, type: WRITES)

            databaseHops.push({
                function: fnId,
                interaction: interaction,
                readsTables: readsEdges.map(e => graph.getNode(e.to)),
                writesTables: writesEdges.map(e => graph.getNode(e.to)),
            })

    if databaseHops.length == 0:
        return { completeness: "handler-only", callChain, hops: [] }

    return { completeness: "complete", callChain, hops: databaseHops }
```

### 6.3 Example Trace

Query: "What happens when GET /api/users/:id is called?"

```
traceFromEndpoint("APIEndpoint:GET:/api/users/:id")

Step 1: HANDLES → getUserHandler (server.ts:15)

Step 2: BFS from getUserHandler
  depth 0: getUserHandler
    CALLS_FUNCTION → getUserById (services/users.ts:7)  [cross-file]
  depth 1: getUserById
    (no further CALLS_FUNCTION edges)

Step 3: Database interactions
  getUserById PERFORMS → prisma.user.findUnique({ where: { id } })
    READS → User table

Result:
  completeness: "complete"
  callChain:
    getUserHandler → getUserById
  databaseHops:
    [{ function: getUserById, operation: read, table: User }]
```

Visual:

```
+-------------------+
| GET /api/users/:id|
+--------+----------+
         |
      HANDLES
         |
         v
+--------+----------+     CALLS_FUNCTION     +----------------+
| getUserHandler    |────────────────────────>| getUserById   |
| server.ts:15     |     (cross-file)        | users.ts:7    |
|                  |                          |               |
| - parses req.    |                          | - calls prisma|
|   params.id      |                          |   .user       |
| - returns 404    |                          |   .findUnique |
|   if not found   |                          |               |
| - returns user   |                          |               |
|   as JSON        |                          |               |
+-------------------+                         +-------+-------+
                                                      |
                                                  PERFORMS
                                                      |
                                                      v
                                              +-------+--------+
                                              | prisma.user    |
                                              | .findUnique()  |
                                              | { where: {id} }|
                                              +-------+--------+
                                                      |
                                                   READS
                                                      |
                                                      v
                                              +-------+--------+
                                              | User table     |
                                              | id, email,     |
                                              | name, createdAt|
                                              +----------------+
```

## 7. Complete Server Graph for the Sample App

```
SERVER-SIDE CALL GRAPH (sample-react-express-prisma)

ROUTE LAYER (server.ts)                  SERVICE LAYER                    DATA LAYER

+-------------------+  HANDLES  +-------------------+  PERFORMS  +------------------+  READS   +-------+
| GET /api/users    |─────────>| listUsersHandler  |          | listUsers        |────────>| prisma |
|                   |          | server.ts:10      |─CALLS──>| users.ts:3       |─PERFORMS>| .user  |
+-------------------+          +-------------------+          +------------------+          | .find  |
                                                                                           | Many() |
                                                                                           +---+----+
                                                                                               |READS
                                                                                               v
+-------------------+  HANDLES  +-------------------+  PERFORMS  +------------------+      +-------+
| GET               |─────────>| getUserHandler    |          | getUserById      |      | User  |
| /api/users/:id    |          | server.ts:15      |─CALLS──>| users.ts:7       |      | table |
+-------------------+          +-------------------+          +------------------+      +-------+
                                                                   |PERFORMS                ^
                                                                   v                       |READS
                                                              +----------+                 |
                                                              | prisma   |─────────────────+
                                                              | .user    |
                                                              | .find    |
                                                              | Unique() |
                                                              +----------+

+-------------------+  HANDLES  +-------------------+          +------------------+
| POST /api/users   |─────────>| createUserHandler |          | createUser       |
|                   |          | server.ts:25      |─CALLS──>| users.ts:11      |
+-------------------+          +-------------------+          +------------------+
                                                                   |PERFORMS
                                                                   v
                                                              +----------+  WRITES  +------+
                                                              | prisma   |────────>| User |
                                                              | .user    |         | table|
                                                              | .create()|         +------+
                                                              +----------+

+-------------------+  HANDLES  +-------------------+          +------------------+
| PUT               |─────────>| updateUserHandler |          | updateUser       |
| /api/users/:id    |          | server.ts:31      |─CALLS──>| users.ts:15      |
+-------------------+          +-------------------+          +------------------+
                                                                   |PERFORMS
                                                                   v
                                                              +----------+  WRITES  +------+
                                                              | prisma   |────────>| User |
                                                              | .user    |         | table|
                                                              | .update()|         +------+
                                                              +----------+

+-------------------+  HANDLES  +-------------------+          +------------------+
| DELETE            |─────────>| deleteUserHandler |          | deleteUser       |
| /api/users/:id    |          | server.ts:38      |─CALLS──>| users.ts:19      |
+-------------------+          +-------------------+          +------------------+
                                                                   |PERFORMS
                                                                   v
                                                              +----------+  WRITES  +------+
                                                              | prisma   |────────>| User |
                                                              | .user    |         | table|
                                                              | .delete()|         +------+
                                                              +----------+

+-------------------+  HANDLES  +-------------------+          +------------------+
| GET /api/users/   |─────────>| listPostsHandler |          | listPostsByUser  |
| :userId/posts     |          | server.ts:52      |─CALLS──>| posts.ts:3       |
+-------------------+          +-------------------+          +------------------+
                                                                   |PERFORMS
                                                                   v
                                                              +----------+  READS   +------+
                                                              | prisma   |────────>| Post |
                                                              | .post    |         | table|
                                                              | .find    |         +------+
                                                              | Many()   |
                                                              +----------+

+-------------------+  HANDLES  +-------------------+          +------------------+
| POST /api/users/  |─────────>| createPostHandler |          | createPost       |
| :userId/posts     |          | server.ts:58      |─CALLS──>| posts.ts:7       |
+-------------------+          +-------------------+          +------------------+
                                                                   |PERFORMS
                                                                   v
                                                              +----------+  WRITES  +------+
                                                              | prisma   |────────>| Post |
                                                              | .post    |         | table|
                                                              | .create()|         +------+
                                                              +----------+

+-------------------+  HANDLES  +-------------------+          +------------------+
| DELETE /api/users/|─────────>| deletePostHandler |          | deletePost       |
| :userId/posts/:id |          | server.ts:65      |─CALLS──>| posts.ts:11      |
+-------------------+          +-------------------+          +------------------+
                                                                   |PERFORMS
                                                                   v
                                                              +----------+  WRITES  +------+
                                                              | prisma   |────────>| Post |
                                                              | .post    |         | table|
                                                              | .delete()|         +------+
                                                              +----------+

ORPHANS (no endpoint reaches them):
  +----------+
  | Comment  |  ← declared in Prisma schema, no service functions,
  | table    |    no endpoints. Dead table or future feature.
  +----------+

SUMMARY:
  8 endpoints, 8 handlers, 8 service functions, 8 database interactions
  2 tables active (User, Post), 1 table orphaned (Comment)
  All HANDLES edges: exact (same-file resolution in sample app)
  All CALLS_FUNCTION edges: cross-file (handlers import from services/)
  All PERFORMS edges: exact (direct Prisma CRUD calls)
```

## 8. Edge Cases and Challenges

### 8.1 Middleware That Modifies the Request

```typescript
app.get('/api/users', authenticate, listUsersHandler);

function authenticate(req, res, next) {
    const token = req.headers.authorization;
    const user = verifyToken(token);
    req.user = user;  // attaches to request
    next();
}
```

The middleware calls `next()` which invokes the next function in the chain. It also modifies `req` by attaching `.user`. The call graph should show:
- Middleware functions as part of the endpoint's execution path
- The `next()` call as the link to the next middleware/handler

For Phase 1, recording middleware as metadata on the endpoint is sufficient. Deeper middleware analysis (what does each middleware do, what does it add to `req`) is a detail analyzer concern (R-4.1).

### 8.2 Error Handling Middleware

```typescript
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});
```

Express error handlers have 4 parameters. They catch errors thrown by any handler. These are global — they don't belong to a single endpoint. The server graph should emit them as special nodes (e.g., `ErrorHandler`) linked to all endpoints, or linked to the app itself.

### 8.3 Database Transactions

```typescript
async function transferFunds(fromId, toId, amount) {
    await prisma.$transaction([
        prisma.account.update({ where: { id: fromId }, data: { balance: { decrement: amount } } }),
        prisma.account.update({ where: { id: toId }, data: { balance: { increment: amount } } }),
    ]);
}
```

A single function performs multiple database operations atomically. The graph should show both WRITES edges from the same function. The existing framework-prisma visitor already handles this — each `prisma.account.update()` inside the transaction array is a separate call expression that gets its own `DatabaseInteraction` node.

### 8.4 Dynamic Route Registration

```typescript
const resources = ['users', 'posts', 'comments'];
for (const resource of resources) {
    app.get(`/api/${resource}`, createListHandler(resource));
    app.post(`/api/${resource}`, createCreateHandler(resource));
}
```

Routes are registered dynamically in a loop. The path is a template literal with a variable. The Express visitor cannot extract a static route pattern. This is a `confidence: "dynamic"` situation. Options:
- Record the template and let the human/AI resolve it
- If the loop variable iterates over a static array, unroll it

### 8.5 NestJS Decorator-Based Routes (Future)

```typescript
@Controller('users')
export class UsersController {
    constructor(private usersService: UsersService) {}

    @Get()
    findAll() {
        return this.usersService.findAll();
    }

    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.usersService.findOne(id);
    }
}
```

This requires a different detection approach:
- The route is composed from class decorator `@Controller('users')` + method decorator `@Get(':id')`
- The handler is the decorated method itself (no separate HANDLES edge needed)
- Dependency injection (`private usersService: UsersService`) creates implicit call edges — calling `this.usersService.findAll()` dispatches to the injected `UsersService` class

This is a future `framework-nestjs` visitor. The core graph-building algorithm (per-file walk → cross-file resolution → BFS trace) remains the same.

### 8.6 Multi-Database Access

```typescript
async function syncUser(userId) {
    const user = await postgres.user.findUnique({ where: { id: userId } });
    await redis.set(`user:${userId}`, JSON.stringify(user));
    await elastic.index({ index: 'users', body: user });
}
```

One function reads from PostgreSQL, writes to Redis, and indexes in Elasticsearch. Each is a different `DatabaseSystem` with different `DatabaseInteraction` nodes. The graph correctly shows all three — the BFS traversal from the handler reaches all three interactions.

The Prisma visitor handles the PostgreSQL call. Redis and Elasticsearch require their own visitors (future plugins).

### 8.7 Cascading Deletes and Database Triggers

```typescript
// Prisma schema
model User {
    posts Post[] // onDelete: Cascade
}

// Code
await prisma.user.delete({ where: { id } });
// This also deletes all Post rows for the user
```

The code shows one `delete` on the User table, but Prisma's cascade deletes also remove Post rows. Static analysis of the code alone misses this. The graph should cross-reference the Prisma schema's `onDelete` rules to surface cascading effects:

```
+-------------------+  WRITES (delete)  +------+  CASCADE_DELETES  +------+
| prisma.user       |────────────────>| User |─────────────────>| Post |
| .delete()         |                 | table|                   | table|
+-------------------+                 +------+                   +------+
```

This is a detail analyzer concern (R-4.1.4) — the Prisma schema parser can emit `CASCADE_DELETES` edges between tables during Phase 1.

## 9. Implementation Summary

### 9.1 Changes to Existing Packages

| Package | Change | Effort |
|---------|--------|--------|
| `@veoable/schema` | Add `HANDLES`, `PERFORMS`, `MIDDLEWARE` edge types | Small |
| `@veoable/lang-ts` | Expose `rootDir` in `TsVisitContext` for cross-file handler resolution | Small |
| `@veoable/framework-express` | Follow imports to resolve handler FunctionDefinition ids, detect `app.use` mounts, emit inline handler FunctionDefinition nodes | Medium |
| `@veoable/framework-prisma` | Emit `PERFORMS` edges (currently uses `PERFORMED_BY` which is reverse direction), detect cascade rules from schema | Small |
| `@veoable/flow-stitcher` | Update flow walker to use `HANDLES` edge, support router composition | Medium |
| `@veoable/mcp-server` | Add `list_server_endpoints` tool with downstream effects summary | Small |

### 9.2 What Doesn't Change

- The per-file AST walk architecture (single walk, framework visitor dispatch)
- The structural extractor (FunctionDefinition, CALLS_FUNCTION, IMPORTS, EXPORTS)
- The SQLite graph store (commit, query, content-addressed IDs)
- The evidence system (#96)
- The client-side graph (independent)

### 9.3 Performance Characteristics

- **Phase 1**: Same as today — O(AST nodes) per file, parallelizable. Adding inline handler detection and middleware recording is negligible overhead.
- **Phase 2**: Import graph resolution is O(imports * exports). Router composition is O(mounts * routes per router). Both are small relative to AST parsing.
- **Phase 3**: BFS from endpoint through call graph is O(functions + edges), bounded by `maxCallDepth`. Same as the current flow walker.

The server graph adds fewer nodes than the client graph (no callback-per-JSX-attribute inflation). A typical Express app with 50 endpoints, 50 handlers, 100 service functions, and 200 database interactions produces ~400 nodes — well within bounds.
