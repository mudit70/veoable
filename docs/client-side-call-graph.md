# Building a Client-Side Call Graph

## 1. Goal

Build a complete, scope-accurate call graph of the client-side code such that for any UI interaction (button click, form submit, page load), we can trace exactly which functions execute and which API calls are made — without any false positives from unrelated code paths sharing the same component scope.

## 2. High-Level Approach

The graph is built in three phases:

```
Phase 1                    Phase 2                    Phase 3
Per-File AST Walk          Cross-File Resolution      Scope-Accurate Tracing
(embarrassingly parallel)  (needs global view)        (query-time)

+--------+                 +--------+--------+        +---------+
| file A | ──> nodes,      | import |        |        | onClick |
|        |     edges,       | graph  | merge  |        |   |     |
+--------+     imports      |        | edges  |        |   v     |
                            +--------+        |        | arrow() |
+--------+                 | cross- |        |        |   |     |
| file B | ──> nodes,      | file   | ──────>|        |   v     |
|        |     edges,       | call   |        |        | fetch() |
+--------+     imports      | edges  |        |        +---------+
                            +--------+--------+
+--------+
| file C | ──> nodes,
|        |     edges,
+--------+     imports
```

**Phase 1** can process every file independently — no cross-file knowledge needed. This is the expensive AST work, and it parallelizes perfectly.

**Phase 2** links the per-file graphs together using import/export relationships. This requires a global view but operates on the lightweight import graph, not the full ASTs.

**Phase 3** is query-time traversal. Given a specific UI interaction, walk the graph from that interaction's callback to find all reachable API calls.

## 3. Phase 1: Per-File AST Walk

### 3.1 What We Extract From Each File

For each source file, a single recursive AST walk extracts:

```
Source File
  |
  +-- Function Definitions (all of them)
  |     - named function declarations
  |     - arrow functions bound to variables
  |     - class methods
  |     - inline arrow functions in JSX attributes  <-- NEW in v2
  |     - callback arguments to known functions (useEffect, etc.)
  |
  +-- Client-Side Processes (UI triggers)
  |     - JSX event attributes: onClick, onSubmit, onChange, ...
  |     - Lifecycle hooks: useEffect, useLayoutEffect
  |
  +-- Client-Side API Callers (outbound HTTP)
  |     - fetch() calls with method + URL
  |     - axios/ky/etc. calls (future)
  |
  +-- Intra-File Call Edges
  |     - function A calls function B (both in this file)
  |     - resolved via identifier → symbol → declaration
  |
  +-- Import/Export Declarations
  |     - what this file imports from other files
  |     - what this file exports
  |
  +-- Trigger Edges (UI → callback)
        - which ClientSideProcess triggers which function
```

### 3.2 The Single-Walk Algorithm

We walk the AST once, maintaining a stack of enclosing functions:

```
walkNode(node, state):
    pushed = null

    // 1. Is this node a function-shaped declaration?
    if node is FunctionDeclaration or ArrowFunction or MethodDeclaration:
        fnDef = buildFunctionDefinition(node)
        emit(fnDef)
        emit(DEFINED_IN edge: fnDef → sourceFile)
        pushed = fnDef

    // 2. Is this node a JSX event attribute?
    if node is JsxAttribute and name starts with "on" + uppercase:
        process = buildClientSideProcess(node)
        emit(process)

        // KEY: resolve what the attribute value points to
        value = node.getInitializer()
        if value is JsxExpression:
            expr = value.getExpression()
            targetFn = resolveToFunction(expr)  // see 3.3
            if targetFn:
                emit(TRIGGERS edge: process → targetFn)

    // 3. Is this node a lifecycle hook call?
    if node is CallExpression and callee is "useEffect" etc.:
        process = buildClientSideProcess(node)
        emit(process)

        // The first argument is the callback
        callback = node.getArguments()[0]
        if callback is ArrowFunction or FunctionExpression:
            callbackFn = buildFunctionDefinition(callback)
            emit(callbackFn)
            emit(TRIGGERS edge: process → callbackFn)
            pushed = callbackFn  // children walk inside this scope

    // 4. Is this node a fetch() call?
    if node is CallExpression and callee is "fetch":
        if state.enclosingFunction exists:
            caller = buildClientSideAPICaller(node)
            emit(caller)
            emit(MAKES_REQUEST edge: state.enclosingFunction → caller)

    // 5. Is this node a call to another function in this file?
    if node is CallExpression and callee resolves to same-file function:
        if state.enclosingFunction exists:
            targetId = resolveToFunctionId(callee)
            emit(CALLS_FUNCTION edge: state.enclosingFunction → targetId)

    // 6. Dispatch to framework visitors (same as v1)
    for visitor in state.visitors:
        visitor.onNode(state.visitCtx, node)

    // Push onto stack AFTER visitor dispatch (children see this as enclosing)
    if pushed:
        state.functionStack.push(pushed)

    // 7. Recurse into children
    for child in node.getChildren():
        walkNode(child, state)

    // 8. Pop on the way back up
    if pushed:
        state.functionStack.pop()
```

### 3.3 Resolving JSX Attribute Values

The value of a JSX event attribute can take several forms. Each needs different resolution:

```
Form 1: Inline arrow function
─────────────────────────────
<button onClick={() => { fetch('/api/users') }}>

  Resolution: The arrow IS the callback.
  Emit FunctionDefinition for the arrow.
  Emit TRIGGERS: onClick-process → arrow-fn.

  +---------+  TRIGGERS  +-----------+  MAKES_REQUEST  +----------+
  | onClick |──────────>| arrow()   |────────────────>| fetch()  |
  | :25     |           | :25-27    |                 | POST     |
  +---------+           +-----------+                 | /api/usr |
                                                      +----------+


Form 2: Named function reference (same file)
─────────────────────────────────────────────
const handleClick = () => { fetch('/api/users') };
<button onClick={handleClick}>

  Resolution: Resolve identifier "handleClick" via ts-morph symbol.
  Symbol → declaration → FunctionDefinition already emitted.
  Emit TRIGGERS: onClick-process → handleClick-fn.

  +---------+  TRIGGERS  +-------------+  MAKES_REQUEST  +----------+
  | onClick |──────────>| handleClick |────────────────>| fetch()  |
  | :5      |           | :1-3        |                 | POST     |
  +---------+           +-------------+                 | /api/usr |
                                                        +----------+


Form 3: Named function reference (imported)
───────────────────────────────────────────
import { handleClick } from './handlers';
<button onClick={handleClick}>

  Resolution: Resolve identifier → ImportSpecifier.
  Record a PENDING_TRIGGER that Phase 2 will resolve
  using the import graph.

  +---------+  TRIGGERS  +-------------------+
  | onClick |──────────>| handleClick       |
  | :3      |  (pending) | (imported from    |
  +---------+            |  ./handlers.ts)   |
                         +-------------------+
                              |
                    Phase 2 resolves to:
                              |
                              v
                         +-------------+  MAKES_REQUEST  +----------+
                         | handleClick |────────────────>| fetch()  |
                         | handlers:5  |                 | POST     |
                         +-------------+                 | /api/usr |
                                                         +----------+


Form 4: Call expression (HOC / wrapper)
───────────────────────────────────────
<button onClick={withAuth(handleClick)}>

  Resolution: The value is a CallExpression, not an identifier.
  We can't statically resolve what function `withAuth(handleClick)`
  returns. Record as TRIGGERS with confidence: "dynamic".

  Option A: Emit TRIGGERS to the wrapper function (withAuth).
            The wrapper's body likely calls the argument, so BFS
            will find the inner function via call edges.

  Option B: Surface to human/AI: "onClick calls withAuth(handleClick)
            — which function ultimately runs?"

  +---------+  TRIGGERS     +----------+  CALLS_FUNCTION  +-------------+
  | onClick |──────────────>| withAuth |────────────────>| handleClick |
  | :3      | (dynamic)     | :1       |  (arg passing)  | :5          |
  +---------+               +----------+                  +-------------+


Form 5: Member expression
─────────────────────────
<button onClick={this.handleClick}>
<button onClick={actions.deleteUser}>

  Resolution: Resolve via property access. For `this.X`, resolve
  within the class. For `obj.X`, resolve the object's type/definition.
  Often needs type-checker support.

  Confidence: "heuristic" — name-based matching if type resolution fails.
```

### 3.4 Handling React Hooks

Hooks are function calls, not JSX attributes, but they're equally important as flow entry points.

```
useEffect Pattern
─────────────────
useEffect(() => {
    fetch('/api/users')
      .then(r => r.json())
      .then(setUsers);
}, []);

  The first argument is the effect callback.
  Emit FunctionDefinition for the callback arrow.
  Emit TRIGGERS: useEffect-process → callback-fn.

  +----------+  TRIGGERS  +----------+  MAKES_REQUEST  +----------+
  | useEffect|──────────>| effect() |────────────────>| fetch()  |
  | :12      |           | :12-16   |                 | GET      |
  +----------+           +----------+                 | /api/usr |
                                                      +----------+


Custom Hook Pattern
───────────────────
function useUsers() {
    const [users, setUsers] = useState([]);
    useEffect(() => {
        fetch('/api/users').then(r => r.json()).then(setUsers);
    }, []);
    return users;
}

// In component:
function UserList() {
    const users = useUsers();  // <-- call to custom hook
    ...
}

  The custom hook is a regular function. UserList calls useUsers.
  useUsers contains the useEffect which contains the fetch.
  The call graph handles this naturally:

  +----------+  TRIGGERS  +----------+  CALLS_FUNCTION  +----------+
  | useEffect|──────────>| effect() |                   |          |
  | :3       |           | :3-5     |                   |          |
  +----------+           +----+-----+                   |          |
                              |                         |          |
                         MAKES_REQUEST                  |          |
                              |                         |          |
                              v                         |          |
                         +----------+                   |          |
                         | fetch()  |                   |          |
                         | GET      |                   | useUsers |
                         +----------+                   | :1-7     |
                                                        +----+-----+
                                                             ^
                                                    CALLS_FUNCTION
                                                             |
                                                        +----+-----+
                                                        | UserList |
                                                        | :10-14   |
                                                        +-----------+

  When we walk from UserList's useEffect (via the component that
  calls useUsers), BFS through CALLS_FUNCTION reaches useUsers,
  which contains the useEffect → effect → fetch chain.
```

### 3.5 Per-File Output

After walking one file, we have:

```json
{
  "sourceFile": { "id": "SourceFile:abc123", "filePath": "src/components/UserList.tsx" },
  "functions": [
    { "id": "FunctionDefinition:...", "name": "UserList", "sourceLine": 9 },
    { "id": "FunctionDefinition:...", "name": "useEffect$callback", "sourceLine": 12 }
  ],
  "processes": [
    { "id": "ClientSideProcess:...", "kind": "lifecycle_hook", "name": "useEffect" }
  ],
  "callers": [
    { "id": "ClientSideAPICaller:...", "method": "GET", "url": "/api/users" }
  ],
  "intraFileEdges": [
    { "type": "TRIGGERS", "from": "ClientSideProcess:...", "to": "FunctionDefinition:..." },
    { "type": "MAKES_REQUEST", "from": "FunctionDefinition:...", "to": "ClientSideAPICaller:..." }
  ],
  "imports": [
    { "from": "SourceFile:abc123", "to": "SourceFile:def456", "symbols": ["useUsers"] }
  ],
  "pendingCrossFileEdges": [
    { "type": "CALLS_FUNCTION", "from": "FunctionDefinition:...", "toSymbol": "useUsers", "importedFrom": "./hooks/useUsers" }
  ]
}
```

## 4. Phase 2: Cross-File Resolution

### 4.1 Building the Import Graph

After Phase 1 completes for all files, we have a collection of import declarations. These form a directed graph:

```
UserList.tsx ──imports useUsers──> hooks/useUsers.ts ──imports fetch wrapper──> lib/api.ts
     |                                   |
     +──imports useState──> react        +──imports fetch──> (global)
```

The import graph is lightweight — it's just file IDs and symbol names, not AST nodes. Building it is a simple merge of all per-file import declarations.

### 4.2 Resolving Cross-File Call Edges

For each `pendingCrossFileEdge` from Phase 1:

```
resolveCrossFileEdge(pending, importGraph, allFiles):
    // 1. Find the import declaration
    importEdge = importGraph.find(
        from: pending.sourceFileId,
        symbol: pending.toSymbol
    )

    // 2. Follow the import to the target file
    targetFileId = importEdge.to

    // 3. Find the exported function with that name in the target file
    targetFile = allFiles[targetFileId]
    exportEdge = targetFile.exports.find(name: pending.toSymbol)

    // 4. The export points to a FunctionDefinition
    targetFnId = exportEdge.to

    // 5. Emit the resolved cross-file call edge
    emit(CALLS_FUNCTION: pending.from → targetFnId)
```

### 4.3 Re-Export Chains

Symbols can be re-exported through barrel files:

```
// hooks/index.ts (barrel)
export { useUsers } from './useUsers';

// components/UserList.tsx
import { useUsers } from '../hooks';  // resolves to hooks/index.ts
```

Resolution follows the chain:
```
UserList.tsx
  imports "useUsers" from "../hooks"
    → hooks/index.ts
      re-exports "useUsers" from "./useUsers"
        → hooks/useUsers.ts
          exports function useUsers
```

The import graph already captures re-exports as IMPORTS edges with `isDynamic: false`. Following the chain is a simple graph traversal.

### 4.4 Cross-File Resolution Diagram

```
PHASE 1 OUTPUT (per file):                    PHASE 2 OUTPUT (merged):

UserList.tsx:                                 +----------+
  FunctionDef: UserList                       | UserList | ──CALLS_FUNCTION──+
  FunctionDef: useEffect$callback             +----------+                   |
  Process: useEffect                               |                         |
  pending: UserList calls useUsers (imported)  TRIGGERS                      |
                                                   |                         |
hooks/useUsers.ts:                                 v                         |
  FunctionDef: useUsers                       +----------+                   |
  FunctionDef: useEffect$callback             | useEffect|                   |
  Process: useEffect                          | $callback|                   |
  Caller: fetch GET /api/users                +----+-----+                   |
  export: useUsers                                 |                         |
                                              MAKES_REQUEST                  |
                                                   |                         |
                                                   v                         v
                                              +----------+             +----------+
                                              | fetch()  |             | useUsers |
                                              | GET      |             | (resolved|
                                              | /api/usr |             |  cross-  |
                                              +----------+             |  file)   |
                                                                       +----------+
```

### 4.5 What Cross-File Resolution Cannot Do

Some patterns resist static resolution:

```
// Dynamic imports
const module = await import(`./pages/${pageName}`);
module.handler();
// → Can't know which file at analysis time. Record as dynamic.

// Computed property access
const handlers = { create: handleCreate, delete: handleDelete };
<button onClick={handlers[action]}>
// → Can't know which handler at analysis time. Record as dynamic.

// Higher-order component wrapping across files
export default connect(mapState)(UserList);
// → The connect() wrapper is opaque. Would need Redux-specific analysis.
```

These are surfaced as `confidence: "dynamic"` nodes for human/AI resolution.

## 5. Phase 3: Scope-Accurate Tracing (Query Time)

### 5.1 The Query

Given a `ClientSideProcess` (e.g., an `onClick` handler), find all `ClientSideAPICaller` nodes reachable from it.

### 5.2 The Algorithm

```
traceFromProcess(processId, graph, maxDepth=10):
    // 1. Find the TRIGGERS edge to get the specific callback
    triggersEdges = graph.findEdges(from: processId, type: TRIGGERS)
    if none:
        return { completeness: "process-only", callers: [] }

    callbackFnId = triggersEdges[0].to

    // 2. BFS from the callback through CALLS_FUNCTION edges
    visited = Set()
    frontier = [callbackFnId]
    reachableFunctions = Set([callbackFnId])
    depth = 0

    while frontier is not empty AND depth < maxDepth:
        nextFrontier = []
        for fnId in frontier:
            if fnId in visited: continue
            visited.add(fnId)

            callEdges = graph.findEdges(from: fnId, type: CALLS_FUNCTION)
            for edge in callEdges:
                if edge.to not in visited:
                    nextFrontier.push(edge.to)
                    reachableFunctions.add(edge.to)

        frontier = nextFrontier
        depth += 1

    // 3. Find all API callers made by reachable functions
    callers = []
    for fnId in reachableFunctions:
        requestEdges = graph.findEdges(from: fnId, type: MAKES_REQUEST)
        for edge in requestEdges:
            callers.push(graph.getNode(edge.to))

    return { completeness: "caller-found", callers }
```

### 5.3 Why This Eliminates False Positives

Consider `CreateUserForm`:

```tsx
export function CreateUserForm() {                    // FunctionDef: CreateUserForm
    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    return (
        <form onSubmit={(e) => {                       // FunctionDef: onSubmit$callback
            e.preventDefault();
            fetch('/api/users', { method: 'POST' });   // Caller: POST /api/users
        }}>
            <input onChange={(e) => setEmail(e.target.value)} />   // FunctionDef: onChange$callback_1
            <input onChange={(e) => setName(e.target.value)} />    // FunctionDef: onChange$callback_2
        </form>
    );
}
```

**v1 graph (scope pollution):**
```
All three processes share enclosingFunction = CreateUserForm.
BFS from CreateUserForm reaches fetch() for ALL of them.

onChange (email)  ──┐
onChange (name)   ──┤── all via CreateUserForm ──> fetch() POST   WRONG!
onSubmit          ──┘
```

**v2 graph (scope-accurate):**
```
Each process has its own TRIGGERS edge to its specific callback.
BFS from each callback only reaches what that callback actually calls.

onChange (email)  ── TRIGGERS ──> onChange$callback_1 ──> setEmail()     (no fetch)
onChange (name)   ── TRIGGERS ──> onChange$callback_2 ──> setName()      (no fetch)
onSubmit          ── TRIGGERS ──> onSubmit$callback  ──> fetch() POST   CORRECT
```

### 5.4 Tracing Diagram for the Sample App

```
CLIENT-SIDE CALL GRAPH (sample-react-express-prisma)

UserList.tsx:
  +----------+  TRIGGERS  +----------------+  MAKES_REQUEST  +-------------------+
  | useEffect|──────────>| useEffect$cb   |────────────────>| GET /api/users    |
  | :12      |           | :12-16         |                 | confidence: exact |
  +----------+           +----------------+                 +-------------------+

CreateUserForm.tsx:
  +----------+  TRIGGERS  +----------------+  MAKES_REQUEST  +-------------------+
  | onSubmit |──────────>| onSubmit$cb    |────────────────>| POST /api/users   |
  | :9       |           | :9-16          |                 | confidence: exact |
  +----------+           +----------------+                 +-------------------+

  +----------+  TRIGGERS  +----------------+
  | onChange  |──────────>| onChange$cb_1  |──> setEmail()   (no API call)
  | :18      |           | :18            |
  +----------+           +----------------+

  +----------+  TRIGGERS  +----------------+
  | onChange  |──────────>| onChange$cb_2  |──> setName()    (no API call)
  | :19      |           | :19            |
  +----------+           +----------------+

UserDetail.tsx:
  +----------+  TRIGGERS  +----------------+  MAKES_REQUEST  +------------------------+
  | useEffect|──────────>| useEffect$cb   |────────────────>| GET /api/users/${id}   |
  | :14      |           | :14-18         |                 | confidence: pattern    |
  +----------+           +----------------+                 +------------------------+

  +----------+  TRIGGERS  +----------------+  MAKES_REQUEST  +------------------------+
  | onClick  |──────────>| onClick$cb_1   |────────────────>| PUT /api/users/${id}   |
  | :25      |           | :25-31         |                 | confidence: pattern    |
  +----------+           +----------------+                 +------------------------+

  +----------+  TRIGGERS  +----------------+  MAKES_REQUEST  +------------------------+
  | onClick  |──────────>| onClick$cb_2   |────────────────>| DELETE /api/users/${id}|
  | :37      |           | :37-39         |                 | confidence: pattern    |
  +----------+           +----------------+                 +------------------------+

PostList.tsx:
  +----------+  TRIGGERS  +----------------+  MAKES_REQUEST  +-------------------------------+
  | useEffect|──────────>| useEffect$cb   |────────────────>| GET /api/users/${uid}/posts   |
  | :13      |           | :13-17         |                 | confidence: pattern           |
  +----------+           +----------------+                 +-------------------------------+

  +----------+  TRIGGERS  +----------------+  CALLS_FUNCTION  +---------------+
  | onClick  |──────────>| handleRefresh  |────────────────>| (same fetch   |
  | :40      |  (named   | :32-36         |  MAKES_REQUEST  |  as useEffect)|
  +----------+   ref)    +----------------+                 +---------------+

TOTAL: 8 processes, 6 unique API callers, 0 false positives
```

## 6. Edge Cases and Challenges

### 6.1 Conditional API Calls

```tsx
onClick={() => {
    if (isLoggedIn) {
        fetch('/api/protected');
    } else {
        fetch('/api/login');
    }
}}
```

Both fetch calls are reachable from the onClick callback. The graph correctly shows both — it's the human's job to understand the branching. We could optionally mark edges with `isConditional: true` by checking if the call is inside an `if`/`switch`/ternary.

### 6.2 Async Chains and Callbacks

```tsx
fetch('/api/users')
    .then(r => r.json())
    .then(users => {
        fetch(`/api/users/${users[0].id}/posts`);  // second fetch
    });
```

The `.then()` callbacks are arrow functions. The structural extractor should emit FunctionDefinition nodes for them and CALLS_FUNCTION edges from the enclosing function. The second `fetch` is then reachable via BFS.

### 6.3 Event Emitter Patterns

```tsx
eventBus.on('user-created', () => { fetch('/api/analytics') });
eventBus.emit('user-created');
```

Static analysis cannot connect `emit` to `on` without understanding the event bus semantics. This is a `confidence: "dynamic"` situation — surface to human/AI.

### 6.4 State Management (Redux/Zustand)

```tsx
// Component
dispatch(fetchUsers());

// Action creator
const fetchUsers = () => async (dispatch) => {
    const users = await fetch('/api/users');
    dispatch(setUsers(users));
};
```

The `dispatch(fetchUsers())` call doesn't directly call `fetch`. The thunk middleware intercepts the action and calls the returned function. This requires Redux-specific analysis:
- Detect `dispatch(actionCreator())` pattern
- Follow the action creator to its thunk body
- The thunk body contains the actual `fetch` call

This is a framework-specific visitor (future `framework-redux` plugin), not a change to the core graph-building algorithm.

### 6.5 Component Composition

```tsx
// Parent passes handler to child
<ChildComponent onSave={handleSave} />

// Child uses it
function ChildComponent({ onSave }) {
    return <button onClick={onSave}>Save</button>;
}
```

The `onClick` in ChildComponent points to the `onSave` prop, which is passed from the parent. Static resolution requires:
1. Detecting that `onSave` is a prop (function parameter)
2. Finding all call sites of `ChildComponent`
3. Resolving the `onSave` prop value at each call site

This is feasible with ts-morph's `findReferences()` but expensive. A pragmatic approach: trace props that are JSX attributes with `on`-prefix names, flag as `confidence: "heuristic"`.

## 7. Implementation Summary

### 7.1 Changes to Existing Packages

| Package | Change | Effort |
|---------|--------|--------|
| `@veoable/schema` | Add `TRIGGERS`, `MAKES_REQUEST` edge types | Small |
| `@veoable/lang-ts` | Emit FunctionDefinition for inline JSX callbacks and hook callbacks | Medium |
| `@veoable/framework-react` | Emit TRIGGERS edges, resolve named function refs | Medium |
| `@veoable/framework-fetch` | Emit MAKES_REQUEST edges | Small |
| `@veoable/flow-stitcher` | Update flow walker to use TRIGGERS for scope-accurate tracing | Medium |
| `@veoable/mcp-server` | Add `list_client_api_calls` tool | Small |

### 7.2 New vs. Modified

No new packages needed. The client-side call graph is built by the existing `lang-ts` + `framework-react` + `framework-fetch` pipeline with the additions described above. The key change is **granularity** — emitting callback-level function nodes and scope-specific trigger edges instead of attributing everything to the component function.

### 7.3 Performance Considerations

- **Phase 1** (per-file AST walk): Already optimized with single-walk architecture and reused `TsVisitContext`. Adding inline callback detection is O(JSX attributes per file) — negligible.
- **Phase 2** (cross-file resolution): O(imports * exports) for the resolution step. The import graph is small relative to the AST.
- **Phase 3** (BFS traversal): O(functions + call edges) per query. Bounded by `maxCallDepth`. Same as v1.

The main cost increase is more `FunctionDefinition` nodes (one per inline callback vs. zero today). For a typical React component with 3-5 event handlers, this adds 3-5 nodes per component — well within acceptable bounds.
