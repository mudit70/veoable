# React-Native-Only Veoable: A Minimal Build

This guide describes how to implement a smaller, focused version of Veoable that supports a **React Native frontend** plus the five backends most commonly paired with it in production. It distills the full architecture (`docs/architecture-2.md`) down to the parts you actually need, names the packages to keep or drop, and walks through the plugin contract you must implement for each backend.

The goal of the smaller app is the same as the parent project — build a knowledge graph of UI interactions → outbound API calls → server endpoints → DB writes — but scoped so a single developer can stand it up in an afternoon.

---

## 1. Scope

### Frontend (one)
- **React Native** (bare React Navigation _and_ Expo Router)

### Backends (five)
| # | Backend | Language | Why it ships in this set |
|---|---------|----------|--------------------------|
| 1 | **Express** | TypeScript / JS | Default REST backend for the JS ecosystem; almost every RN tutorial pairs with it |
| 2 | **NestJS** | TypeScript | Structured, decorator-driven Node backend — the "production" choice for TS-first teams |
| 3 | **Supabase** | (BaaS) TS client | Most common drop-in BaaS for RN — auth, Postgres, realtime; called directly from the client |
| 4 | **tRPC** | TypeScript | End-to-end typed RPC; highly popular in Expo + monorepo setups |
| 5 | **FastAPI** | Python | The dominant pick when the RN app talks to a Python/ML backend |

### What the smaller app does NOT do
- Other frontend frameworks (React web, Vue, Svelte, Angular, Next.js, Remix).
- Other languages (Go, Rust, Java, PHP).
- Other backends in those languages (Spring, Gin, Laravel, etc.).
- HTML/Liquid template parsing.
- The full presentation layer — keep CLI text + JSON output, drop GUI/NLP.
- Cross-repo project routing (single-repo or simple multi-repo only).

---

## 2. Architecture (boiled down)

The full pipeline (`docs/architecture-2.md` §3) collapses to four phases. Keep all four:

```
+──────────────+    +──────────────+    +──────────────+    +──────────────+
|  Client      |    |  Server      |    |  Stitching   |    |  Combined    |
|  Graph       | →  |  Graph       | →  |  Layer       | →  |  Graph       |
|  (RN)        |    |  (5 backends)|    |  (cascade)   |    |  (SQLite)    |
+──────────────+    +──────────────+    +──────────────+    +──────────────+
```

- **Client graph** — built by the React Native plugin + the HTTP-egress plugins (`fetch`, `axios`) + the Supabase/tRPC client visitors.
- **Server graph** — built by the Express, NestJS, FastAPI plugins (and the server side of tRPC). Supabase has no server graph in this minimal build — its endpoints are the Supabase SaaS, which is treated as a `DatabaseSystem` node with direct client writes.
- **Stitching layer** — connects client API callers to server endpoints. Use the cascade in `docs/architecture-2.md` §6.2 but only the first three strategies (exact URL, segment-count, shared constants). Skip AI/contextual stitching to keep the build slim.
- **Combined graph** — SQLite via `better-sqlite3`. Keep the schema in `packages/schema` unchanged.

---

## 3. Packages to keep, drop, and add

### Keep verbatim
| Package | Why |
|---------|-----|
| `packages/schema` | Canonical node/edge types (zod-based); reusing it preserves the graph contract |
| `packages/plugin-api` | `LanguagePlugin` and `FrameworkPlugin` interfaces (`packages/plugin-api/src/framework-plugin.ts:17`) |
| `packages/lang-ts` | TypeScript AST walker — needed by RN, Express, NestJS, Supabase, tRPC |
| `packages/lang-py` | Python AST walker — needed by FastAPI |
| `packages/graph-db` | SQLite store and query helpers |
| `packages/flow-stitcher` | Stitching cascade (you'll trim its strategy list, see §5) |
| `packages/observability` | Logging + evidence builders used by every visitor |
| `packages/cli` | Entry point; you'll trim `discover.ts` to register only the kept plugins |

### Keep these framework plugins (unchanged)
- `framework-react-native` — JSX event handlers, `useEffect`, `navigation.navigate()`, `<Stack.Screen>` (see `packages/framework-react-native/src/visitor.ts`)
- `framework-fetch` — `fetch()` outbound calls; activates on every TS project (`packages/framework-fetch/src/fetch-plugin.ts:30`)
- `framework-axios` — `axios.get/post/...`
- `framework-express` — REST routes
- `framework-nestjs` — `@Controller`, `@Get`, `@Post`, etc.
- `framework-supabase` — `supabase.from('table').select(...)` client calls; emits a `DatabaseSystem` node and DB-interaction edges (`packages/framework-supabase/src/supabase-plugin.ts`)
- `framework-trpc` — both client (`trpc.user.byId.useQuery(...)`) and server (`router({ ... })`) sides
- `framework-fastapi` — `@app.get(...)`, `APIRouter`

### Drop completely
Every framework whose name appears in `packages/cli/src/discover.ts` other than the ones above. Concretely: react (web), vue, svelte, angular, nextjs, remix, hono, koa, hapi, fastify, gin, gohttp, actix, axum, rocket, spring, jpa, gorm, laravel, django, flask, sqlalchemy, prisma, typeorm, mongoose, graphql, state-mgmt, pycli/gocli/rustcli, plus the lang-go/java/php/rust/html plugins.

You can delete those packages from the workspace and remove their imports from `discover.ts`. Nothing else in the codebase depends on them — each framework plugin is self-contained behind the `FrameworkPlugin` interface.

### Add (optional, for DB completeness)
None required. If your RN app talks to Express/NestJS/FastAPI that themselves write to a database, you'd want a database plugin (Prisma, TypeORM, SQLAlchemy). For the smallest build, leave the server graph ending at the handler function — flows still trace UI → handler, just not into the DB.

---

## 4. Implementing the React Native frontend

The `framework-react-native` package is already complete in this repo. Don't rewrite it — copy it as-is. The contract is small:

```ts
// packages/framework-react-native/src/react-native-plugin.ts:23
export class ReactNativePlugin implements FrameworkPlugin {
  readonly id = 'react-native';
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    // True when 'react-native' or 'expo' is in package.json deps
  }

  readonly visitor: TsFrameworkVisitor = createReactNativeVisitor();
}
```

What the visitor emits (see `packages/framework-react-native/src/visitor.ts`):

| AST shape | Emitted node/edge |
|-----------|-------------------|
| `<Pressable onPress={...}>` (any `on[A-Z]…` JSX attr) | `ClientSideProcess { kind: 'event_handler' }` |
| `useEffect(() => …, [])` | `ClientSideProcess { kind: 'lifecycle_hook' }` |
| `navigation.navigate('Home')` / `router.push('/home')` | `NAVIGATES_TO` edge to a `Screen` node |
| `<Stack.Screen name="Home" component={HomeScreen}/>` | `Screen` node + `SCREEN_COMPONENT` edge |

Mutual exclusion with `framework-react`: when `react-native`/`expo` is in deps, the RN plugin takes over (`packages/framework-react-native/src/react-native-plugin.ts:14`). In a RN-only build you don't ship `framework-react` at all, so this concern goes away.

The actual API call (e.g. `fetch('/api/users')` inside an `onPress`) is detected by `framework-fetch` or `framework-axios`, not by the RN visitor itself. This separation is deliberate and is what lets one frontend plugin work with any of the five backends.

---

## 5. Implementing the five backends

Every backend plugin is the same shape (`FrameworkPlugin`). The only thing that changes is `appliesTo()` (how to detect the framework) and the visitor (what AST patterns to match). Reuse the existing implementations — the work is mostly in trimming `discover.ts` and writing tests for the RN-specific call sites.

### 5.1 Express (TypeScript)

- **Detection** (`packages/framework-express/src/express-plugin.ts`): `hasDependency(ctx, 'express')`.
- **Visitor matches**: `app.get('/path', handler)`, `router.post(...)`, `app.use('/prefix', subRouter)`.
- **Emits**: `APIEndpoint { httpMethod, routePattern, handlerFunctionId }`, `HANDLES` edge.
- **Stitches with**: `fetch`/`axios` callers from the RN client by URL + method.

### 5.2 NestJS (TypeScript)

- **Detection** (`packages/framework-nestjs/src/nestjs-plugin.ts:11`): `@nestjs/core` or `@nestjs/common` in deps.
- **Visitor matches**: `@Controller('users')` class decorators + `@Get(':id')`/`@Post()` method decorators. Compose controller path + method path for the full route.
- **Emits**: same `APIEndpoint` nodes with `framework: 'nestjs'`.
- **Stitches**: identical to Express — URL + method.

### 5.3 Supabase (TypeScript, client-only)

- **Detection** (`packages/framework-supabase/src/supabase-plugin.ts:15`): `@supabase/supabase-js` in deps.
- **Visitor matches**: `supabase.from('table').select/.insert/.update/.delete(...)`.
- **Emits**: a `DatabaseSystem` node (PostgreSQL kind) once per project via `onProjectLoaded` (`framework-supabase/src/supabase-plugin.ts:24`), plus `DatabaseInteraction` and `READS`/`WRITES` edges per call site.
- **Stitches**: nothing — the RN code talks to Supabase directly. The graph already has a path from `ClientSideProcess → arrow_fn → DatabaseInteraction → DatabaseTable` without crossing any HTTP boundary.

This is the one backend in this set that has no server graph; treat it as "the database is also the API."

### 5.4 tRPC (TypeScript, both sides)

- **Detection** (`packages/framework-trpc/src/trpc-plugin.ts:11`): `@trpc/server` or `@trpc/react-query` in deps.
- **Server visitor matches**: `router({ getUser: publicProcedure.input(...).query(...) })`. Each procedure becomes an `APIEndpoint` whose `routePattern` is the dotted path (`getUser`, `users.byId`) and `httpMethod` is `POST` (tRPC over HTTP) or `TRPC` if you want it kept distinct.
- **Client visitor matches**: `trpc.users.byId.useQuery(input)` and `useMutation(...)`. Emit a `ClientSideAPICaller` whose URL is the procedure path.
- **Stitches**: by procedure path, not URL — it's a deterministic match because both sides reference the same dotted name. Use stitch strategy #1 (exact match on the procedure path).

### 5.5 FastAPI (Python)

- **Detection** (`packages/framework-fastapi/src/fastapi-plugin.ts:13`): `fastapi` in `requirements.txt` or `pyproject.toml`.
- **Visitor matches**: `@app.get('/users/{id}')`, `@router.post('/users')`, `APIRouter(prefix='/users')`.
- **Emits**: `APIEndpoint` nodes with `framework: 'fastapi'`. Convert `{id}` route params to `:id` so they line up with the client-graph segment-count matcher.
- **Stitches**: URL + method, exactly like Express.

You'll need `lang-py` for this one. Drop `lang-go`/`lang-java`/`lang-php`/`lang-rust`.

---

## 6. Stitching cascade (trimmed)

Full cascade lives in `docs/architecture-2.md` §6.2 (six strategies). For a minimal build, ship three:

1. **Exact URL + method** — `fetch('/api/users')` ↔ `GET /api/users`.
2. **Segment-count** — `` fetch(`/api/users/${id}`) `` ↔ `GET /api/users/:id`. The fetch visitor already emits template parts and span count (`packages/framework-fetch/src/visitor.ts`); the matcher counts segments and matches on that.
3. **Procedure-path** (tRPC only) — exact match on the dotted path string.

Skip strategies 4–6 (heuristic pattern, AI contextual, human confirmation). They add a lot of surface area — MCP tools for `confirm_stitch`/`reject_stitch`/`auto_stitch`, persistence of confirmation metadata — that you don't need if you're only trying to validate the model.

For Supabase, stitching is a no-op: client calls land directly on `DatabaseTable` nodes via `READS`/`WRITES` edges.

---

## 7. CLI and orchestration

Trim `packages/cli/src/discover.ts` (currently 158 lines of imports) to just the kept languages and frameworks:

```ts
// languages
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { PyLanguagePlugin } from '@veoable/lang-py';

// frameworks
import { ReactNativePlugin } from '@veoable/framework-react-native';
import { FetchPlugin } from '@veoable/framework-fetch';
import { AxiosPlugin } from '@veoable/framework-axios';
import { ExpressPlugin } from '@veoable/framework-express';
import { NestjsPlugin } from '@veoable/framework-nestjs';
import { SupabasePlugin } from '@veoable/framework-supabase';
import { TrpcPlugin } from '@veoable/framework-trpc';
import { FastapiPlugin } from '@veoable/framework-fastapi';
```

Update the `LANGUAGE_REGISTRY` to only `ts` and `py`, and the framework list to the eight above. The orchestration loop in `analyze.ts` is plugin-agnostic — it just iterates whatever `discover.ts` returns — so nothing else changes.

CLI surface to keep:
- `adorable analyze <path>` — build the graph
- `adorable analyze <path> -o graph.db` — persist
- `adorable analyze <path> --format json` — machine-readable output

CLI surface to drop:
- `adorable project create/add-repo` (multi-repo)
- `adorable chat` (NLP layer)
- `--transport http` and the MCP server (`packages/mcp-server`) — nice to have for Claude integration, but not needed for the core build

---

## 8. Suggested directory layout

```
rn-adorable/
├── packages/
│   ├── schema/                  # copy from upstream, unchanged
│   ├── plugin-api/              # copy, unchanged
│   ├── lang-ts/                 # copy, unchanged
│   ├── lang-py/                 # copy, unchanged
│   ├── graph-db/                # copy, unchanged
│   ├── flow-stitcher/           # copy, trim to 3 strategies
│   ├── observability/           # copy, unchanged
│   ├── framework-react-native/  # copy, unchanged
│   ├── framework-fetch/         # copy, unchanged
│   ├── framework-axios/         # copy, unchanged
│   ├── framework-express/       # copy, unchanged
│   ├── framework-nestjs/        # copy, unchanged
│   ├── framework-supabase/      # copy, unchanged
│   ├── framework-trpc/          # copy, unchanged
│   ├── framework-fastapi/       # copy, unchanged
│   └── cli/                     # copy, trim discover.ts
├── examples/
│   ├── rn-expo-router/          # mirrors examples/stack-samples/expo-router
│   └── rn-bare/                 # mirrors examples/stack-samples/react-native-bare
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

---

## 9. Build order (week-one plan)

1. **Day 1** — Scaffold the workspace, copy `schema`, `plugin-api`, `graph-db`, `observability`. Get `pnpm -r build` green with no plugins yet.
2. **Day 2** — Add `lang-ts`, `framework-react-native`, `framework-fetch`. Stand up the CLI; analyze the `expo-router` example. You should see `Screen`, `ClientSideProcess`, `ClientSideAPICaller` nodes in the graph.
3. **Day 3** — Add `framework-express`. Point the CLI at a tiny RN-frontend + Express-backend monorepo and confirm stitches appear.
4. **Day 4** — Add `framework-nestjs`, `framework-supabase`, `framework-trpc`. Each is the same wiring step plus a sample app under `examples/`.
5. **Day 5** — Add `lang-py` and `framework-fastapi`. Now the analyzer spans two languages.
6. **Day 6** — Trim `flow-stitcher` to the three-strategy cascade. Write end-to-end tests that walk a flow from `onPress` to a server handler for each backend.
7. **Day 7** — Polish CLI output, write a short README, decide whether to ship the MCP server.

---

## 10. Open design questions (decide before implementing)

- **Supabase row-level-security** — the visitor doesn't read RLS policies; the graph claims `WRITES → User` even when RLS would actually reject the call at runtime. Document this as a known limitation rather than trying to fix it.
- **tRPC over WebSocket** — the URL-based stitcher assumes HTTP. For subscriptions you'd extend `APIEndpoint` with a `transport` field; not in scope for v1.
- **Expo Router file-based routes** — current visitor handles `<Stack.Screen>` declarations and `router.push('/path')` calls but doesn't index the `app/` directory itself. If your sample apps are Expo-Router-only, add a project-level pass that converts `app/(tabs)/index.tsx` → `Screen { name: 'tabs-index' }` to make the navigation graph complete.
- **Auth headers as flow context** — if Supabase or tRPC uses an auth interceptor, the graph won't show it. Out of scope for the minimal build; revisit when you add middleware-chain recording (Architecture v2 §5.6).

---

## 11. Reference: file map

When you're stuck, these are the files to read in the upstream Veoable repo:

| Topic | File |
|-------|------|
| RN visitor (canonical example) | `packages/framework-react-native/src/visitor.ts` |
| RN plugin shell | `packages/framework-react-native/src/react-native-plugin.ts` |
| Plugin contract | `packages/plugin-api/src/framework-plugin.ts` |
| Language plugin contract | `packages/plugin-api/src/language-plugin.ts` |
| Plugin discovery / registration | `packages/cli/src/discover.ts` |
| End-to-end orchestration | `packages/cli/src/analyze.ts` |
| Node/edge schemas | `packages/schema/src/nodes.ts`, `packages/schema/src/edges.ts` |
| Full architecture | `docs/architecture-2.md` |
| Client call-graph design | `docs/client-side-call-graph.md` |
| Server call-graph design | `docs/server-side-call-graph.md` |
| Stitching design | `docs/cross-boundary-stitching.md` |

That's the whole minimal build: one frontend visitor, two HTTP-egress visitors, five backend visitors, two languages, three stitching strategies, one CLI command. Everything else in the parent project is reachable from the same plugin contracts but explicitly out of scope for this slim build.
