# React-Native-Only Veoable: From Scratch

This is the companion to `docs/reactnative-only-app.md`. That guide trims the existing Veoable codebase down. **This guide assumes you start from an empty repo** and write every package yourself, treating the upstream Veoable code only as a reference design.

Pick this path if you want to:
- Learn the architecture by re-deriving it.
- Use a different stack (e.g., Rust + tree-sitter, or a Go binary instead of a Node CLI).
- Avoid coupling to upstream package boundaries, licensing, or release cadence.

**Don't pick this path** if you just want a working analyzer fast — the trim-down guide gets you there in a week. The from-scratch route is closer to a month of focused work.

Same scope as the trim-down guide:
- **Frontend**: React Native (bare + Expo Router)
- **Backends**: Express, NestJS, Supabase, tRPC, FastAPI

---

## 1. Mindset shift: contracts before code

Veoable's superpower is that every plugin is a tiny implementation of two interfaces. If you copy nothing else from the upstream design, copy that. Build in this order:

```
   schema (data shapes)
        │
        ▼
   plugin contracts (interfaces)
        │
        ▼
   ┌────┴────┐
   │         │
language    framework
plugins     plugins
   │         │
   └────┬────┘
        ▼
  orchestrator (walks files, calls visitors, batches results)
        │
        ▼
   graph store (SQLite)
        │
        ▼
   stitcher + CLI
```

The reason to build the schema and the contracts first — even before you've written a single visitor — is that they're the only thing that has to be _designed_. Everything below them is a mechanical implementation of those contracts. Get them wrong and every plugin you write afterwards has to change.

---

## 2. Phase 0 — Repository scaffold (½ day)

```
rn-veoable/
├── package.json              # workspace root, private: true
├── pnpm-workspace.yaml       # packages: ["packages/*"]
├── tsconfig.base.json        # strict, ES2022, NodeNext modules
├── vitest.config.ts          # workspace-level test runner
└── packages/                 # empty for now
```

Decisions to make on day one and not revisit:
- **Module system**: ESM only (`"type": "module"`). Don't dual-emit.
- **Package manager**: pnpm with workspaces. npm/yarn workspaces work but pnpm is what the upstream uses and the perf matters once you have ~10 packages.
- **TS build**: `tsup` per package. One config file, ESM output, `.d.ts` emit.
- **Test runner**: Vitest. Co-located `__tests__` directories per package.
- **Lockfile in source control**: yes.

Get `pnpm -r build` to succeed against zero packages. That's phase 0 done.

---

## 3. Phase 1 — Schema package (1 day)

This is the only package where the upstream design genuinely deserves to be copied verbatim — it's the wire format between everything else, and getting it wrong is expensive.

Create `packages/schema/` with three modules:

### `nodes.ts` — what gets stored

Define zod schemas for the **minimum** node set. Don't add fields you don't need yet; widen later.

```ts
// Minimum viable node set for RN + 5 backends
SourceFile        { id, filePath, repository, language, framework? }
FunctionDefinition { id, name, sourceFileId, sourceLine, parameters[], isAsync, isExported }
Screen            { id, name, navigatorKind, componentFunctionId?, sourceFileId, framework }
ClientSideProcess { id, kind: 'event_handler' | 'lifecycle_hook', name, functionId, framework }
ClientSideAPICaller { id, functionId, httpMethod, urlTemplate, urlSpans, confidence, sourceLine }
APIEndpoint       { id, httpMethod, routePattern, handlerFunctionId?, framework, repository }
DatabaseSystem    { id, kind: 'postgres', name, connectionSource? }      // Supabase only
DatabaseInteraction { id, operation: 'read'|'write'|'delete', table, functionId }
```

Five fields earn their place: `id` (content-addressed hash so re-runs are stable), `sourceFileId` + `sourceLine` (so the UI can jump to code), `framework` (so a query can scope by stack), `evidence` (so an LLM can cite it later), and `confidence` (so heuristic results are flagged).

### `edges.ts` — relationships

```
TRIGGERS         ClientSideProcess → FunctionDefinition
CALLS_FUNCTION   FunctionDefinition → FunctionDefinition
MAKES_REQUEST    FunctionDefinition → ClientSideAPICaller
NAVIGATES_TO     FunctionDefinition → Screen
SCREEN_COMPONENT Screen → FunctionDefinition
HANDLES          APIEndpoint → FunctionDefinition
PERFORMS         FunctionDefinition → DatabaseInteraction
RESOLVES_TO_ENDPOINT  ClientSideAPICaller → APIEndpoint   (the stitch)
```

### `ids.ts` — content-addressed IDs

One helper per node type, all delegating to `sha256(canonical-json).slice(0, 16)`. Stable IDs are what make incremental re-analysis (and tests) sane.

```ts
export const idFor = {
  sourceFile: ({ repository, filePath }) => hash({ kind: 'SourceFile', repository, filePath }),
  functionDefinition: ({ sourceFileId, name, sourceLine }) =>
    hash({ kind: 'FunctionDefinition', sourceFileId, name, sourceLine }),
  // …one per node type
};
```

Test the schema package by round-tripping a hand-crafted node through `parse` and asserting the ID is stable.

---

## 4. Phase 2 — Plugin contracts (½ day)

Create `packages/plugin-api/`. This package has zero dependencies and exports two interfaces plus a context type. **No implementations.**

```ts
// language-plugin.ts
export interface LanguagePlugin {
  readonly id: string;                              // 'ts' | 'py'
  readonly fileExtensions: readonly string[];       // ['.ts','.tsx','.js','.jsx']
  loadProject(opts: ProjectOptions): Promise<ProjectHandle>;
  extractFile(project: ProjectHandle, filePath: string): Promise<NodeBatch>;
  registerVisitor(visitor: FrameworkVisitor): void;
}

export interface FrameworkVisitor {
  readonly language: string;  // must match a LanguagePlugin.id
}

// framework-plugin.ts
export interface FrameworkPlugin {
  readonly id: string;                              // 'react-native' | 'express' | …
  readonly language: string;                        // 'ts' | 'py'
  appliesTo(ctx: ProjectContext): boolean;
  readonly visitor: FrameworkVisitor;
  onProjectLoaded?(ctx: ProjectContext): NodeBatch | Promise<NodeBatch>;
}
```

Two design rules to bake in here and never break:
1. **Visitors emit; orchestrator commits.** `extractFile` returns a `NodeBatch`; it does not write to SQLite. This makes the pipeline transactional and the visitors testable in isolation.
2. **Visitor shape is owned by the language plugin, not by `plugin-api`.** `FrameworkVisitor` is intentionally opaque here. The TS language plugin will export a concrete `TsFrameworkVisitor` interface; the Python plugin will export `PyFrameworkVisitor`. Framework plugins import from whichever language they target. This keeps `plugin-api` from having to know what an AST node looks like.

---

## 5. Phase 3 — TypeScript language plugin (3 days)

Create `packages/lang-ts/` using **ts-morph** as the AST library. ts-morph wraps the TypeScript compiler API and gives you symbol resolution across files (essential for following imports from JSX `component={X}` to `X`'s definition).

### What `lang-ts` does

1. `loadProject` — instantiate a ts-morph `Project` against the target's `tsconfig.json` (or synthesize one if absent), discover source files.
2. `extractFile` — for each file, walk the AST once and emit:
   - one `SourceFile` node
   - one `FunctionDefinition` per function/arrow/method, including inline arrows in JSX attrs and hook callbacks (the architecture's "scope-accurate tracing" — see §4.4 of `architecture-2.md`)
   - `IMPORTS`, `EXPORTS`, `DEFINED_IN`, `CALLS_FUNCTION` edges
   - whatever the registered framework visitors emitted on the same walk

### The visitor dispatch contract

Define `TsFrameworkVisitor` as:

```ts
export interface TsFrameworkVisitor extends FrameworkVisitor {
  language: 'ts';
  onNode(ctx: TsVisitContext, node: ts-morph.Node): void;
}

export interface TsVisitContext {
  readonly sourceFile: SourceFile;
  readonly enclosingFunction: FunctionDefinition | null;
  readonly rootDir: string;
  readonly repository: string;
  emitNode(node: AnyNode): void;
  emitEdge(edge: AnyEdge): void;
}
```

The single AST walk per file calls `onNode` on every registered framework visitor for every node. Each visitor decides whether the node is interesting and what to emit.

### Things to get right the first time

- **Inline arrow function names**: when an arrow appears in `onPress={() => …}`, synthesize a stable name like `<onPress$line37>` so its `FunctionDefinition` ID is reproducible.
- **Cross-file symbol resolution**: expose `getModuleSpecifierSourceFile()` on the context so framework visitors can follow imports without re-implementing it. The RN visitor uses this to resolve `<Stack.Screen component={HomeScreen}/>` when `HomeScreen` is imported from another file.
- **Test paths excluded by default**: `*.test.ts`, `*.spec.ts`, `*.d.ts`. Make this configurable but ship sensible defaults.

Write integration tests that feed it a 3-file fake project and assert the emitted node/edge set. Don't try to test the full TypeScript compiler — assume ts-morph works.

---

## 6. Phase 4 — Python language plugin (2 days)

Create `packages/lang-py/`. Use **libcst** via a child-process bridge, or **tree-sitter-python** if you want pure Node. The upstream Veoable uses a custom Python parser; for a smaller build, tree-sitter is faster to stand up.

The plugin shape mirrors `lang-ts`:

```ts
export interface PyFrameworkVisitor extends FrameworkVisitor {
  language: 'py';
  onNode(ctx: PyVisitContext, node: TreeSitterNode): void;
}
```

For the from-scratch build, only one framework plugin (FastAPI) targets Python, so the surface area you need to expose is small:
- Function definitions (`def`, `async def`)
- Decorator detection (`@app.get('/path')`)
- Class definitions (for `APIRouter` instances and class-based views)
- String literal extraction (for route patterns)

You don't need full call-graph resolution in Python for v1. FastAPI handlers are reachable from the decorator alone; the body's internals can wait.

---

## 7. Phase 5 — Graph store (1 day)

Create `packages/graph-db/`. Wrap `better-sqlite3`. Two tables:

```sql
CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,
  node_type   TEXT NOT NULL,
  payload     TEXT NOT NULL,    -- JSON
  repository  TEXT
);

CREATE TABLE edges (
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  edge_type   TEXT NOT NULL,
  payload     TEXT,             -- JSON
  PRIMARY KEY (from_id, to_id, edge_type)
);

CREATE INDEX idx_nodes_type ON nodes(node_type);
CREATE INDEX idx_edges_from ON edges(from_id, edge_type);
CREATE INDEX idx_edges_to   ON edges(to_id, edge_type);
```

API surface:

```ts
class GraphStore {
  upsertBatch(batch: NodeBatch): void;        // single transaction
  getNodesByType<T>(type: string): T[];
  getOutgoing(nodeId: string, edgeType?: string): Edge[];
  getIncoming(nodeId: string, edgeType?: string): Edge[];
  walkBfs(startId: string, edgeTypes: string[], maxDepth: number): Path[];
}
```

Keep it boring. The graph is a SQLite blob with two tables; everything fancy lives in the query layer.

---

## 8. Phase 6 — Frontend visitor: React Native (2 days)

Now you finally write a framework plugin. Create `packages/framework-react-native/`.

The detection check:
```ts
appliesTo(ctx) {
  const deps = { ...ctx.packageJson?.dependencies, ...ctx.packageJson?.devDependencies };
  return 'react-native' in deps || 'expo' in deps;
}
```

The visitor recognizes four AST patterns. Implement them in this order — each one independently testable:

1. **JSX event-handler attributes** (1 hour) — any JSX attribute whose name matches `/^on[A-Z]/`. Emit a `ClientSideProcess { kind: 'event_handler' }`.

2. **React lifecycle hook calls** (1 hour) — call expressions whose callee identifier is `useEffect`, `useLayoutEffect`, or `useInsertionEffect`. Emit `ClientSideProcess { kind: 'lifecycle_hook' }`.

3. **Navigation calls** (½ day) — `navigation.navigate('X')`, `navigation.push('X')`, `router.push('/path')`. Guard the receiver against false positives (`array.push()` is not a navigation call). Emit a `NAVIGATES_TO` edge to a `Screen` node, computing the screen ID from the string argument. For Expo Router, normalize `/path/sub` → `path-sub`.

4. **`<Stack.Screen>` declarations** (1 day) — JSX elements whose tag ends in `.Screen`. Extract `name=` and `component=` attrs, resolve the component identifier to a `FunctionDefinition` ID (cross-file via the import-tracing helper in `lang-ts`'s context), emit a `Screen` node and a `SCREEN_COMPONENT` edge. This is the trickiest piece — write generous tests for default vs. named imports, same-file vs. cross-file components, and arrow-function vs. function-declaration components.

What this visitor does **not** do: it does not detect outbound HTTP calls. Those come from `framework-fetch` and `framework-axios`, which are independent plugins. Resist the temptation to bundle them — the separation is what makes one frontend plugin work with five different backends.

---

## 9. Phase 7 — HTTP egress visitors (1 day)

Two tiny plugins:

**`framework-fetch`** — applies to every TS project (no detection, `fetch` is a platform built-in). Match `fetch(url, opts?)` call expressions; extract URL template parts and span count (e.g., `` `/api/users/${id}` `` → parts `['/api/users/', '']`, spans `1`). Emit `ClientSideAPICaller` and a `MAKES_REQUEST` edge. The span count is what the segment-count stitch strategy will key on later, so don't omit it.

**`framework-axios`** — applies when `axios` is in deps. Match `axios.get`, `axios.post`, `axios(config)`, and instances created via `axios.create()`. Most call sites collapse to the same shape as `fetch`.

Both are ~150 lines each. They're shared infrastructure for the entire pipeline.

---

## 10. Phase 8 — The five backend plugins (1 week)

One plugin per backend, ~1 day each. Each follows the same template:

```
packages/framework-{name}/
├── src/
│   ├── {name}-plugin.ts    # the FrameworkPlugin shell
│   ├── visitor.ts          # the AST visitor logic
│   └── index.ts            # exports
└── package.json
```

### 10.1 Express
- **Detect**: `'express'` in deps.
- **Match**: `app.METHOD(path, …handlers)`, `router.METHOD(...)`, `app.use(prefix, router)`.
- **Emit**: `APIEndpoint`, `HANDLES` edge. For mounted routers, compose the prefix with the relative path.
- **Tricky**: handler can be inline arrow, named function, or imported identifier — you need cross-file resolution for the last case.

### 10.2 NestJS
- **Detect**: `'@nestjs/core'` or `'@nestjs/common'` in deps.
- **Match**: classes with `@Controller(prefix?)`, methods with `@Get/Post/Put/Patch/Delete(path?)`.
- **Emit**: same `APIEndpoint` shape. Compose controller prefix + method path.
- **Tricky**: the handler IS the decorated method; no indirection needed.

### 10.3 Supabase
- **Detect**: `'@supabase/supabase-js'` in deps.
- **`onProjectLoaded`**: emit a single `DatabaseSystem { kind: 'postgres', name: 'supabase' }` node and remember its ID.
- **Match**: `supabase.from('table').select()`, `.insert()`, `.update()`, `.delete()`. The receiver chain may go through a stored variable — walk up `getInitializer()` until you hit `supabase.from(...)`.
- **Emit**: `DatabaseInteraction` and `READS`/`WRITES` edges. No `APIEndpoint` — Supabase has no server graph in this build.

### 10.4 tRPC
- **Detect**: `'@trpc/server'` or `'@trpc/react-query'` in deps.
- **Server match**: `router({ procName: publicProcedure.input(...).query(handler) })`. Walk nested routers to build a dotted path (`users.byId`).
- **Client match**: `trpc.users.byId.useQuery(...)`, `useMutation(...)`. The dotted path on the receiver is the procedure name.
- **Emit**: `APIEndpoint { httpMethod: 'TRPC', routePattern: 'users.byId' }` for server; `ClientSideAPICaller { httpMethod: 'TRPC', urlTemplate: 'users.byId' }` for client. The stitcher matches on the procedure path string — no segment counting needed.

### 10.5 FastAPI (Python)
- **Detect**: `fastapi` in `requirements.txt` or `pyproject.toml`.
- **Match**: function definitions with `@app.get('/path')` or `@router.post('/path')` decorators. Track `APIRouter(prefix='/x')` assignments to compose paths.
- **Emit**: `APIEndpoint { framework: 'fastapi' }`. Convert FastAPI's `{id}` syntax to `:id` so the segment-count stitcher matches it against `` fetch(`/api/users/${id}`) ``.

For each plugin, write three integration tests: one for the simplest case (single endpoint, single fetch), one for the medium case (route params, cross-file handler), one for a quirk specific to the framework (Express middleware chain, NestJS controller composition, Supabase cascading methods, tRPC nested routers, FastAPI APIRouter prefix).

---

## 11. Phase 9 — Orchestrator and CLI (2 days)

Create `packages/cli/`. Two responsibilities:

### Discovery / registration
A static registry of language plugins keyed by ID, plus a static list of framework plugin constructors. For each project being analyzed:
1. Determine which languages have files in the tree.
2. Instantiate those language plugins.
3. For each framework plugin, call `appliesTo(ctx)`. If true, register its visitor with the matching language plugin.

### File walk + commit loop
```
for each language plugin:
  await loadProject({ rootDir, repository })

for each source file:
  determine language by extension
  batch = await langPlugin.extractFile(project, filePath)
  graphStore.upsertBatch(batch)

for each framework plugin with onProjectLoaded:
  batch = await plugin.onProjectLoaded(ctx)
  graphStore.upsertBatch(batch)
```

CLI surface — keep it to three commands:
```
rn-veoable analyze <path> [-o output.db] [--format text|json]
rn-veoable stitch <db>             # run the stitcher against a saved graph
rn-veoable query <db> <query>      # a few canned queries: list-endpoints, list-callers, walk-flow
```

Skip MCP, skip multi-repo, skip NLP. Add them later if you want.

---

## 12. Phase 10 — Stitcher (1 day)

Create `packages/flow-stitcher/`. Three strategies, evaluated in order — first unique match wins:

1. **Exact URL + method**: `caller.urlTemplate === endpoint.routePattern && caller.httpMethod === endpoint.httpMethod`.
2. **Segment-count + prefix**: split both URLs on `/`, require equal segment count, require literal prefix to match, allow `:param` to match anything in the param positions.
3. **Procedure-path** (tRPC only): `caller.urlTemplate === endpoint.routePattern` where both are dotted paths like `users.byId`.

For each match, emit a `RESOLVES_TO_ENDPOINT` edge. Nothing fancier; no AI, no human-in-the-loop persistence.

Total stitcher code: ~300 lines.

---

## 13. Phase 11 — End-to-end test (1 day)

Build two sample apps under `examples/`:

```
examples/
├── rn-expo-router-supabase/        # RN + Supabase BaaS
│   ├── package.json   ({react, react-native, expo, expo-router, @supabase/supabase-js})
│   └── app/(tabs)/index.tsx
└── rn-bare-express-fastapi/        # RN + Express auth-svc + FastAPI ml-svc
    ├── frontend/   (RN bare + react-navigation + fetch)
    ├── auth-svc/   (Express)
    └── ml-svc/     (FastAPI)
```

Write integration tests that run `rn-veoable analyze` against each sample and assert the expected nodes, edges, and stitches exist. These tests are your regression net for everything in phases 3–10.

---

## 14. Total time estimate

| Phase | Days | Cumulative |
|------:|-----:|-----------:|
| 0  Repo scaffold        | 0.5 | 0.5 |
| 1  Schema               | 1   | 1.5 |
| 2  Plugin contracts     | 0.5 | 2   |
| 3  TS language plugin   | 3   | 5   |
| 4  Python language plugin | 2 | 7   |
| 5  Graph store          | 1   | 8   |
| 6  RN visitor           | 2   | 10  |
| 7  fetch + axios        | 1   | 11  |
| 8  5 backend plugins    | 5   | 16  |
| 9  CLI / orchestrator   | 2   | 18  |
| 10 Stitcher             | 1   | 19  |
| 11 E2E samples + tests  | 1   | 20  |
| **Total**               | **20** | **~4 weeks** |

Realistic estimate for one engineer with prior TS-tooling experience. Double it if you're new to ts-morph or tree-sitter.

---

## 15. Decisions where you can diverge from upstream Veoable

The trim-down guide preserves upstream choices because diverging means rewriting working code. From scratch, you have license to reconsider:

| Decision | Upstream choice | Alternatives worth considering |
|----------|-----------------|---------------------------------|
| AST library (TS) | ts-morph | tree-sitter-typescript (faster, no symbol resolution) |
| AST library (Python) | custom | tree-sitter-python (zero subprocess overhead) |
| Storage | SQLite via better-sqlite3 | DuckDB (analytical queries are nicer), in-memory only (for short-lived runs) |
| ID scheme | sha256 of canonical JSON | UUIDv7, ULID (chronological ordering) |
| CLI host | Node.js | Bun (faster startup), Deno (no node_modules) |
| Schema validation | zod | valibot (smaller), TypeBox (JSON-Schema-native) |

The contracts in §4 don't change either way — that's the point. Whatever you pick, the per-plugin visitor surface stays the same, and adding a sixth backend later is still a one-day job.

---

## 16. Reference: when to look at upstream code

You're writing this from scratch, but the upstream Veoable repo is the best reference design that exists for this problem. Useful files to read (not copy):

| When you're working on… | Read |
|-------------------------|------|
| Schema design tradeoffs | `packages/schema/src/nodes.ts` |
| Plugin contract phrasing | `packages/plugin-api/src/framework-plugin.ts:17` |
| TS visitor dispatch | `packages/lang-ts/src` |
| RN visitor edge cases (cross-file component resolution!) | `packages/framework-react-native/src/visitor.ts:207` |
| Express handler resolution (the 5 forms it has to handle) | `packages/framework-express/src` |
| Stitch strategy implementations | `packages/flow-stitcher/src` |
| Why each architectural choice was made | `docs/architecture-2.md` |

The upstream code has scars from problems you haven't hit yet — false positives in navigation detection, cross-file import resolution edge cases, mounted-router prefix composition. When your from-scratch implementation surprises you, check whether the upstream solved the same problem already.

---

## 17. What you've gained vs. the trim-down approach

After 4 weeks of from-scratch work you have:
- A codebase you fully understand line by line.
- Freedom to pick a different language/AST/storage stack.
- No upstream dependencies, no vendored license obligations.
- Fewer features (no MCP server, no AI stitching, no multi-repo, no GUI).

The trim-down path gets you a working analyzer in a week with all of upstream's features intact, at the cost of carrying ~20 packages worth of code you didn't write. Pick from-scratch when control matters more than time-to-first-flow.
