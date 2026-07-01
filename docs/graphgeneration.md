# Graph Generation: Import Graph & Call Graph

This document describes how Adorable generates its knowledge graph from TypeScript/JavaScript source code. The process runs in a single pass per file, producing an **import graph** (file-level dependencies), a **call graph** (function-level invocations), and **framework-specific nodes** (API endpoints, fetch calls, database interactions, etc.).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Import Graph](#import-graph)
3. [Call Graph](#call-graph)
4. [Framework Visitors](#framework-visitors)
5. [Pipeline Execution](#pipeline-execution)
6. [Edge Reference](#edge-reference)

---

## Architecture Overview

The graph generation pipeline has three layers that execute within a single AST walk:

```
┌─────────────────────────────────────────────────────────────────┐
│                     TypeScript Source File                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   ts-morph AST Parser                            │
│              (loads project via tsconfig.json)                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┼────────────────┐
              ▼            ▼                ▼
     ┌──────────────┐ ┌──────────┐ ┌─────────────────┐
     │ Structural   │ │ Call     │ │ Framework        │
     │ Extraction   │ │ Graph   │ │ Visitors         │
     │              │ │          │ │                   │
     │ • SourceFile │ │ • CALLS_ │ │ • React           │
     │ • FuncDef    │ │   FUNCTION│ │ • Express/Fastify │
     │ • DEFINED_IN │ │   edges  │ │ • NestJS          │
     │ • EXPORTS    │ │          │ │ • fetch/Axios      │
     │ • IMPORTS    │ │          │ │ • Prisma/Mongoose  │
     └──────────────┘ └──────────┘ └─────────────────┘
              │            │                │
              └────────────┼────────────────┘
                           ▼
                  ┌──────────────────┐
                  │   NodeBatch      │
                  │  { nodes, edges }│
                  └────────┬─────────┘
                           ▼
                  ┌──────────────────┐
                  │  Canonical Store  │
                  │   (SQLite DB)     │
                  └──────────────────┘
```

### Key design decisions

- **Single-pass extraction**: Framework visitors ride on the structural AST walk — no re-walking.
- **Content-addressed IDs**: Every node ID is deterministic (same code produces same ID across runs).
- **Pluggable visitors**: Framework plugins emit nodes/edges via a shared context without knowing the rest of the pipeline.
- **Confidence tracking**: Every call graph edge carries a confidence level (`direct`, `method`, `indirect`, `dynamic`).

---

## Import Graph

The import graph captures file-level dependencies. It answers: "which files depend on which other files?" and "which functions are exported where?"

### Nodes produced

| Node Type | Description | Key Fields |
|-----------|-------------|------------|
| `SourceFile` | One per analyzed file | `filePath`, `repository`, `language` |
| `FunctionDefinition` | Every function, method, arrow, constructor | `name`, `sourceFileId`, `sourceLine`, `isExported`, `isAsync` |

### Edges produced

```
  SourceFile (app.ts)
      │
      ├── IMPORTS ──────────► SourceFile (utils.ts)
      │     symbols: ["formatDate", "parseUrl"]
      │
      ├── IMPORTS ──────────► SourceFile (lodash - external)
      │     symbols: ["debounce"]
      │     isDynamic: false
      │
      ├── EXPORTS ──────────► FunctionDefinition (handleRequest)
      │     exportName: "handleRequest"
      │     isDefault: false
      │
      └── DEFINED_IN ◄────── FunctionDefinition (helperFn)
            (reverse: helperFn is defined in app.ts)
```

### How imports are resolved

The extractor handles three import patterns:

```
┌─────────────────────────────────────────────────────────┐
│              Import Resolution Pipeline                  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  1. Static imports                                       │
│     import { foo } from './bar.js'                       │
│     ──► IMPORTS edge, symbols: ["foo"]                   │
│                                                          │
│  2. Re-exports                                           │
│     export { foo } from './bar.js'                       │
│     export * from './utils.js'                           │
│     ──► IMPORTS edge, symbols: ["foo"] or ["*"]          │
│                                                          │
│  3. Dynamic imports                                      │
│     const mod = await import('./lazy.js')                │
│     ──► IMPORTS edge, isDynamic: true, symbols: []       │
│                                                          │
│  Resolution strategy:                                    │
│     • Try specifier verbatim                             │
│     • Probe extensions: .ts, .tsx, .js, .jsx             │
│     • Rewrite .js → .ts/.tsx (bundler convention)        │
│     • Match against loaded project files                 │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### How functions are discovered

The AST walker identifies seven function-shaped node kinds:

```
┌────────────────────────────────────────────────────────────────┐
│                   Function Discovery                           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Declaration forms:                                            │
│  ├── function handleRequest() {}     → "handleRequest"         │
│  ├── const handler = () => {}        → "handler"               │
│  ├── const fn = function() {}        → "fn"                    │
│  │                                                             │
│  Class members:                                                │
│  ├── class UserService {                                       │
│  │     constructor() {}              → "UserService.constructor"│
│  │     getUser() {}                  → "UserService.getUser"   │
│  │     get name() {}                 → "UserService.get name"  │
│  │   }                                                         │
│  │                                                             │
│  Inline callbacks (synthetic names):                           │
│  ├── <Button onClick={() => {}} />   → "App.onClick$callback"  │
│  ├── useEffect(() => {})             → "App.useEffect$callback"│
│  ├── app.get('/users', (req,res)=>{})→ "GET /users$handler"    │
│  └── const api = { getUsers() {} }   → "api.getUsers"          │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

Every discovered function produces:
- A `FunctionDefinition` node
- A `DEFINED_IN` edge pointing to the `SourceFile`
- An `EXPORTS` edge from the `SourceFile` if the function is exported

---

## Call Graph

The call graph captures function-level invocations. It answers: "which functions call which other functions?" with confidence metadata.

### Edge: CALLS_FUNCTION

```typescript
{
  edgeType: 'CALLS_FUNCTION',
  from: 'FunctionDefinition:abc',   // Caller
  to: 'FunctionDefinition:def',     // Callee (null for unresolved)
  sourceLine: 42,                   // Call site line number
  arguments: ['userId', '"active"'], // Truncated argument expressions
  isConditional: boolean,           // Inside if/while/ternary/catch
  confidence: 'direct' | 'method' | 'indirect' | 'dynamic'
}
```

### Call resolution strategy

The resolver handles four callee patterns, each producing a different confidence level:

```
┌────────────────────────────────────────────────────────────────┐
│                   Call Resolution                              │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Pattern 1: Direct identifier call                             │
│  ─────────────────────────────────                             │
│  handleRequest(req, res)                                       │
│                                                                │
│    Resolver: resolveIdentifierCall()                           │
│    ├─ Symbol → FunctionDeclaration    → confidence: "direct"   │
│    ├─ Symbol → VariableDecl(arrow/fn) → confidence: "direct"   │
│    ├─ Symbol → ImportBinding          → confidence: "direct"   │
│    │    └─ follows alias to original declaration               │
│    └─ Symbol → ParameterDeclaration   → confidence: "indirect" │
│         (callback — caller unknown at compile time)            │
│                                                                │
│  Pattern 2: Property access (method call)                      │
│  ─────────────────────────────────────────                     │
│  userService.getUser(id)                                       │
│  UserModel.findOne({ id })                                     │
│                                                                │
│    Resolver: resolvePropertyAccessCall()                       │
│    ├─ Symbol → MethodDeclaration      → confidence: "method"   │
│    ├─ Symbol → PropertyAssignment(fn) → confidence: "method"   │
│    │    └─ unwraps: { getUser: () => {} } → the arrow          │
│    └─ Symbol → external/non-function  → null (external)        │
│                                                                │
│  Pattern 3: Computed property access                           │
│  ────────────────────────────────────                          │
│  handlers[action]()                                            │
│                                                                │
│    → confidence: "dynamic"                                     │
│    → callee: null (cannot resolve at compile time)             │
│                                                                │
│  Pattern 4: Non-trivial expression                             │
│  ─────────────────────────────────                             │
│  getHandler()(args)                                            │
│  (() => doWork())()                                            │
│                                                                │
│    → confidence: "dynamic"                                     │
│    → callee: null                                              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Enclosing function discovery

Every `CALLS_FUNCTION` edge needs a `from` (the caller). The extractor walks the AST parent chain from the call site until it finds a function-shaped node in its registry:

```
  CallExpression: userService.getUser(id)     ← call site
       │
       ▲ parent chain
       │
  IfStatement                                  ← skip (not a function)
       │
       ▲
       │
  FunctionDeclaration: handleRequest           ← found! This is the caller
       │
       ▲
       │
  SourceFile: routes.ts
```

If the call is inside an `if`, `while`, ternary, `catch`, or logical operator (`&&`, `||`, `??`), the edge is marked `isConditional: true`.

### Cross-file resolution

When a function is imported and called, the resolver follows the import chain:

```
  // routes.ts
  import { createUser } from './handlers.js'

  function handlePost(req, res) {
    createUser(req.body)     ← resolveIdentifierCall()
  }                               │
                                  ▼
                            Symbol.getAliasedSymbol()
                                  │
                                  ▼
                            handlers.ts → FunctionDeclaration: createUser
                                  │
                                  ▼
                            CALLS_FUNCTION edge:
                              from: handlePost (routes.ts)
                              to: createUser (handlers.ts)
                              confidence: "direct"
```

---

## Framework Visitors

Framework visitors extend the base graph with domain-specific nodes and edges. They are dispatched during the same AST walk — each visitor's `onNode()` is called for every AST node, with shared context:

```
┌─────────────────────────────────────────────────────────────┐
│                    TsVisitContext                             │
├─────────────────────────────────────────────────────────────┤
│  sourceFile:        SourceFile node for current file         │
│  enclosingFunction: FunctionDefinition of outer function     │
│  project:           ts-morph Project (cross-file resolution) │
│  rootDir:           Project root path                        │
│  repository:        Repository name                          │
│  emitNode(node):    Append a node to the batch               │
│  emitEdge(edge):    Append an edge to the batch              │
└─────────────────────────────────────────────────────────────┘
```

### Visitor dispatch timing

```
  walkForExtraction() DFS:

  ┌─ Visit AST node ─────────────────────────────────┐
  │                                                    │
  │  1. Identify if this is a function-shaped node     │
  │  2. Record FunctionDefinition + DEFINED_IN edge    │
  │                                                    │
  │  3. ──► Dispatch to ALL registered visitors        │
  │         visitor.onNode(ctx, node)                  │
  │         ctx.enclosingFunction = OUTER function     │
  │         (not the one being declared)               │
  │                                                    │
  │  4. Push function onto stack (if applicable)       │
  │  5. Recurse into children                          │
  │  6. Pop function from stack                        │
  └────────────────────────────────────────────────────┘
```

This ordering ensures visitors see the correct enclosing context — a function declaration belongs to its parent scope, not itself.

### What each visitor produces

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│  React Visitor                                                    │
│  ─────────────                                                    │
│  Detects: onClick, onSubmit, onChange, useEffect, etc.            │
│  Emits:                                                           │
│    ClientSideProcess node (kind: event_handler / lifecycle_hook)  │
│    TRIGGERS edge (process → callback FunctionDefinition)          │
│                                                                   │
│  <Button onClick={handleDelete}>                                  │
│    → ClientSideProcess { kind: "event_handler", name: "onClick" } │
│    → TRIGGERS edge → handleDelete function                        │
│                                                                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Express / Fastify / NestJS Visitors                              │
│  ────────────────────────────────────                             │
│  Detects: app.get(), router.post(), @Get(), register() prefixes  │
│  Emits:                                                           │
│    APIEndpoint node (httpMethod, routePattern, handlerFunctionId) │
│                                                                   │
│  app.get('/api/users', listUsersHandler)                          │
│    → APIEndpoint { httpMethod: "GET", routePattern: "/api/users" }│
│                                                                   │
│  @Controller('users') + @Get(':id')                               │
│    → APIEndpoint { routePattern: "/users/:id", framework:"nestjs"}│
│                                                                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  fetch / Axios Visitors                                           │
│  ──────────────────────                                           │
│  Detects: fetch(), fetchApi(), axios.get(), api.post(), etc.     │
│  Emits:                                                           │
│    ClientSideAPICaller node (httpMethod, urlLiteral, confidence)  │
│    MAKES_REQUEST edge (enclosing function → caller)               │
│                                                                   │
│  fetch(`/api/users/${id}`, { method: 'DELETE' })                  │
│    → ClientSideAPICaller { httpMethod:"DELETE", url:"/api/users/" │
│        egressConfidence: "pattern", templateParts:["/api/users/"] │
│    → MAKES_REQUEST edge from enclosing function                   │
│                                                                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Prisma / Mongoose Visitors                                       │
│  ──────────────────────────                                       │
│  Detects: prisma.user.findMany(), Model.find(), .save()          │
│  Emits:                                                           │
│    DatabaseInteraction node (operation: read/write/delete)        │
│    READS / WRITES edges (interaction → DatabaseTable)             │
│    PERFORMED_BY edge (interaction → enclosing function)           │
│                                                                   │
│  prisma.user.create({ data })                                     │
│    → DatabaseInteraction { operation: "create" }                  │
│    → WRITES edge → DatabaseTable "User"                           │
│    → PERFORMED_BY edge → enclosing function                       │
│                                                                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Redux Saga Visitor                                               │
│  ──────────────────                                               │
│  Detects: takeLatest(ACTION, handler), dispatch({ type: ACTION }) │
│  Emits:                                                           │
│    CALLS_FUNCTION edges (dispatch caller → saga handler)          │
│    confidence: "indirect"                                         │
│                                                                   │
│  Binds dispatch({ type: 'FETCH_USER' })                           │
│    → CALLS_FUNCTION edge → saga handler for 'FETCH_USER'         │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Constant URL propagation

Framework visitors use `resolveToString()` to trace compile-time string values through the AST:

```
  const API_BASE = '/api';                    ← string literal
  const USERS_URL = `${API_BASE}/users`;      ← template + const ref
  fetch(USERS_URL);                           ← variable reference

  resolveToString(USERS_URL)
    → resolve variable → template literal
      → resolve API_BASE → '/api'
      → join: '/api/users'

  Resolution chain:
    StringLiteral     → direct value
    Const variable    → follow to initializer
    Object property   → API.LOGIN → follow to value
    Enum member       → HttpMethod.GET → 'GET'
    Binary concat     → '/api' + '/users' → '/api/users'
    Template literal  → join spans with resolved expressions
    Max depth: 10     → prevents infinite recursion
```

---

## Pipeline Execution

The complete execution flow for analyzing one project:

```
  CLI: adorable analyze ./my-project --output graph.db
                    │
                    ▼
  ┌─────────────────────────────────────────────────────────┐
  │  1. Load Project                                         │
  │     TsLanguagePlugin.loadProject("./my-project")         │
  │     ├─ Find tsconfig.json                                │
  │     ├─ Create ts-morph Project                           │
  │     └─ Load all source files into memory                 │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  2. Register Framework Visitors                          │
  │     plugin.registerVisitor(reactVisitor)                  │
  │     plugin.registerVisitor(expressVisitor)                │
  │     plugin.registerVisitor(fetchVisitor)                  │
  │     plugin.registerVisitor(prismaVisitor)                 │
  │     ...                                                   │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  3. Extract Each File                                    │
  │     for each sourceFile in project:                      │
  │       plugin.extractFile(handle, filePath)                │
  │                                                           │
  │     ┌───────────────────────────────────────────────┐    │
  │     │  extractSourceFile()                           │    │
  │     │                                                │    │
  │     │  A. Create SourceFile node                     │    │
  │     │                                                │    │
  │     │  B. DFS walk (walkForExtraction)               │    │
  │     │     for each AST node:                         │    │
  │     │       ├─ Identify functions → FunctionDef node │    │
  │     │       ├─ Emit DEFINED_IN edge                  │    │
  │     │       ├─ Dispatch to framework visitors        │    │
  │     │       │   ├─ React: emit ClientSideProcess     │    │
  │     │       │   ├─ Express: emit APIEndpoint         │    │
  │     │       │   ├─ fetch: emit ClientSideAPICaller   │    │
  │     │       │   └─ Prisma: emit DatabaseInteraction  │    │
  │     │       └─ Recurse into children                 │    │
  │     │                                                │    │
  │     │  C. Emit EXPORTS edges (exported functions)    │    │
  │     │  D. Emit IMPORTS edges (static + dynamic)      │    │
  │     │                                                │    │
  │     │  E. extractCalls() — separate pass             │    │
  │     │     for each CallExpression:                    │    │
  │     │       ├─ Find enclosing function               │    │
  │     │       ├─ Resolve callee                        │    │
  │     │       └─ Emit CALLS_FUNCTION edge              │    │
  │     │                                                │    │
  │     │  Return: NodeBatch { nodes, edges }            │    │
  │     └───────────────────────────────────────────────┘    │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  4. Commit to Store                                      │
  │     store.commit(batch, meta)                             │
  │     ├─ Validate every node and edge against schema       │
  │     ├─ Upsert nodes (content-addressed, idempotent)      │
  │     └─ Upsert edges (content-hashed, deduplicated)       │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  5. Post-Processing                                      │
  │     ├─ Fastify prefix composition (register() prefixes)  │
  │     ├─ Redux Saga dispatch edge emission                 │
  │     └─ URL stitching (RESOLVES_TO_ENDPOINT edges)        │
  └─────────────────────────────────────────────────────────┘
```

---

## Edge Reference

Complete list of edge types generated during graph construction:

| Edge Type | From → To | Confidence | Generated By |
|-----------|-----------|------------|--------------|
| `IMPORTS` | SourceFile → SourceFile | — | Static imports, re-exports, dynamic imports |
| `EXPORTS` | SourceFile → FunctionDefinition | — | Exported functions (`export`, `export default`) |
| `DEFINED_IN` | FunctionDefinition → SourceFile | — | Every function definition |
| `CALLS_FUNCTION` | FunctionDefinition → FunctionDefinition | direct, method, indirect, dynamic | Call expressions |
| `TRIGGERS` | ClientSideProcess → FunctionDefinition | — | React event handlers, lifecycle hooks |
| `MAKES_REQUEST` | FunctionDefinition → ClientSideAPICaller | — | fetch/axios HTTP calls |
| `RESOLVES_TO_ENDPOINT` | ClientSideAPICaller → APIEndpoint | high/medium/low | URL stitcher (post-extraction) |
| `READS` | DatabaseInteraction → DatabaseTable | — | Prisma/Mongoose read operations |
| `WRITES` | DatabaseInteraction → DatabaseTable | — | Prisma/Mongoose write operations |
| `PERFORMED_BY` | DatabaseInteraction → FunctionDefinition | — | Function containing DB call |
| `TABLE_IN` | DatabaseTable → DatabaseSystem | — | Schema extraction |
| `COLUMN_IN` | DatabaseColumn → DatabaseTable | — | Schema extraction |
| `FOREIGN_KEY` | DatabaseColumn → DatabaseColumn | — | Schema foreign key relations |

### End-to-end flow example

The edges combine to form complete flows:

```
  ClientSideProcess (onClick: "Delete User")
       │
       │ TRIGGERS
       ▼
  FunctionDefinition (handleDelete)
       │
       │ CALLS_FUNCTION (direct)
       ▼
  FunctionDefinition (deleteUser)
       │
       │ MAKES_REQUEST
       ▼
  ClientSideAPICaller (DELETE /api/users/:id)
       │
       │ RESOLVES_TO_ENDPOINT (stitched)
       ▼
  APIEndpoint (DELETE /api/users/:id)
       │
       │ handler → CALLS_FUNCTION chain
       ▼
  FunctionDefinition (deleteUserHandler)
       │
       │ CALLS_FUNCTION (method)
       ▼
  FunctionDefinition (UserService.remove)
       │
       │ PERFORMED_BY (reverse)
       ▼
  DatabaseInteraction (delete)
       │
       │ WRITES
       ▼
  DatabaseTable (User)
```

This chain is what the flow walker traverses to produce the end-to-end flow view exposed through the MCP tools.
