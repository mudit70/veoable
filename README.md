# Veoable

**Veoable analyzes your codebase and builds a queryable graph of end-to-end
flows** — UI handler → API call → backend endpoint → service → database
read/write → response → DOM update. Point an AI assistant (Claude, Cursor,
any MCP-compatible client) at that graph and it can answer questions like
_"what happens when a user clicks the login button?"_ with grounded,
traversed answers instead of guesses.

```
[UI handler] ──HTTP──▶ [endpoint] ──▶ [service] ──▶ [DB] ──▶ [response] ──▶ [DOM]
     ▲                                                                          │
     └──────────────────────── grounded answer ◀──────────── MCP tool call ─────┘
```

Coverage spans **six languages** (TypeScript / JavaScript, Python, Go, Rust,
Java, PHP) and **114+ framework plugins** — see the
[coverage matrix](#coverage-at-a-glance) below.

**Latest release:** v0.3.0 — cross-language framework breadth, monorepo
loader, detection-vs-emission split, cross-repo stitch fixes. See the
[User Guide](docs/userguide.md) and the
[LLM Client Install Guide](docs/llm-client-install.md).

## Table of contents

- [Quick start](#quick-start)
- [What Veoable is for](#what-veoable-is-for)
- [Coverage at a glance](#coverage-at-a-glance)
- [Architecture invariants](#architecture-invariants)
- [Repository layout](#repository-layout)
- [Migrating from `@adorable/*`](#migrating-from-adorable)
- [Community](#community)
- [License](#license)

## Quick start

Requires **Node.js 20+** and **pnpm 10**.

```bash
git clone https://github.com/mudit70/veoable
cd veoable
pnpm install
pnpm install-cli   # exposes `veoable` on your $PATH
```

The 60-second tour — from `git clone` to Claude answering questions
about your code — lives in the [User Guide](docs/userguide.md#the-60-second-tour).

```bash
# 1. Analyze a project (writes a canonical graph to graph.db)
veoable analyze ./my-project --output graph.db

# 2. Start the MCP server so an LLM can query the graph
veoable serve graph.db

# 3. Or chat directly from the terminal
veoable chat graph.db --provider anthropic --model claude-sonnet-4
```

For multi-repo systems (front-end + back-end + shared library), use
`veoable project init` to generate a config, then `veoable project analyze`
to build one stitched graph across all repositories. See
[Multi-repo projects](docs/userguide.md#multi-repo-projects) in the User
Guide.

## What Veoable is for

Veoable answers a specific class of question: **"if I change X, what
breaks?"** and **"what happens when a user does Y?"** — grounded in code
you actually shipped, not summarized from a training corpus.

Concretely: it takes code — human-written or AI-generated — and produces
an addressable graph of every API endpoint, client-side API caller, UI
interaction element, database access, and the typed edges between them.
That compressed context grounds an AI assistant when you're debugging,
fixing, or changing anything in the flow.

Typical uses:

- **Blast-radius analysis** — "which callers, screens, and DB tables are
  affected if I change this endpoint?"
- **End-to-end flow tracing** — "walk me through what happens between
  the user clicking submit and the request landing in the database."
- **Cross-service impact** — for microservice or monorepo setups where
  a single flow crosses multiple repositories.
- **AI-assisted refactors** — Claude or Cursor can propose changes with
  full knowledge of every caller and every downstream data touch.
- **Onboarding** — new engineers get a queryable map of the codebase
  instead of skimming READMEs.

## Coverage at a glance

**Languages:** TypeScript / JavaScript, Python, Go, Rust, plus Java
(Spring / JPA) and PHP (Laravel).

**Framework families (114+ plugins):**

- **Web servers** — Next.js, Express, NestJS, Fastify, Django, FastAPI,
  Flask, Gin, Echo, Fiber, Chi, Axum, Actix, Warp, Poem, Rocket, Spring,
  Laravel, and more.
- **HTTP clients** — fetch, axios, httpx, reqwest, gRPC (all four
  languages).
- **SQL ORMs** — Prisma, Drizzle, TypeORM, Sequelize, MikroORM, Knex,
  SQLAlchemy, SQLModel, Peewee, Tortoise, GORM, SQLx, Diesel, SeaORM,
  Ent, JPA.
- **NoSQL & KV** — Mongoose, PyMongo, mongo-go, mongorust, ioredis,
  redispy, redisrs, go-redis, Memcached (all four).
- **Object storage** — S3, GCS, Azure Blob (TypeScript, Python, Go, Rust).
- **Messaging** — Kafka (JS, Py, Go, Rust), RabbitMQ (JS, Py, Go, Rust),
  BullMQ, Celery, Asynq, Apalis.
- **WebSockets** — TypeScript, Python, Go, Rust.
- **Elasticsearch** — TypeScript, Python, Go, Rust.
- **MCP servers** — TypeScript + Rust.
- **Frontend** — React, React Native, React Router, React Query, SWR,
  Vue, Angular, Svelte, Next.js pages/app router, Remix, tRPC client.

The full matrix, including which edges each plugin emits, lives in the
[User Guide](docs/userguide.md#framework-coverage).

## Architecture invariants

Two load-bearing rules — expected of every contribution. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full versions.

1. **Split parsers by language, not by framework.** One `LanguagePlugin`
   per language owns the AST walk (`lang-ts`, `lang-py`, `lang-go`, …).
   All `FrameworkPlugin`s targeting that language register visitors that
   share the single walk. A framework plugin must **never** instantiate
   its own parser for source files in that language.

2. **Split graphs by repository.** Multi-repo projects analyze each repo
   independently and stitch results in the flow-stitcher layer.

Cross-cutting concerns belong in the language plugin or in
`plugin-api`, **not** duplicated across framework plugins.

## Repository layout

```
packages/
  cli/                       # veoable CLI (analyze, serve, chat, project)
  mcp-server/                # MCP server (long-lived, backed by graph.db)
  core/                      # canonical graph model
  graph-db/                  # SQLite-backed storage layer
  flow-stitcher/             # cross-file + cross-repo edge stitching
  lang-{ts,py,go,rust,java,php,html}/   # language plugins (AST walks)
  framework-{...}/           # 114+ framework plugins
  plugin-api/                # types + visitor helpers every plugin uses
  schema/                    # zod schemas for node/edge kinds
  skill/                     # SKILL.md distributed to LLM clients
  observability/             # OpenTelemetry hooks
  trace/                     # runtime instrumentation (fallback edges)
  agents/                    # per-agent orchestrators
  migrate-from-adorable/     # one-shot adorable → veoable upgrade CLI
docs/                        # user + architecture docs
test-apps/                   # per-framework fixture apps
tests/                       # integration + stack tests
```

## Migrating from `@adorable/*`

Veoable is the new home for the project previously released as
[`adorable`](https://github.com/mudit70/adorable). If you were using
`@adorable/*` packages or the `adorable` CLI, upgrade with one command:

```bash
# Preview what would change (safe):
npx @veoable/migrate-from-adorable

# Apply:
npx @veoable/migrate-from-adorable --apply
```

The migrator rewrites `@adorable/*` imports, `package.json` dependency
records, `bin.adorable` / `scripts.adorable`, MCP client configs whose
`mcpServers.adorable` key needs renaming, and CLI usage strings in your
docs. See
[`packages/migrate-from-adorable/README.md`](./packages/migrate-from-adorable/README.md)
for full details.

**License change:** `mudit70/adorable` was MIT; `mudit70/veoable` is
Apache-2.0. Both are permissive and interoperable. See
[`LICENSE`](./LICENSE) and the CHANGELOG entry for context.

## Community

- **Bug reports & feature requests** — open an
  [issue](https://github.com/mudit70/veoable/issues/new/choose) using
  the provided templates.
- **Questions & discussion** —
  [GitHub Discussions](https://github.com/mudit70/veoable/discussions).
- **Security disclosures** — see [`SECURITY.md`](./SECURITY.md); do NOT
  file a public issue.
- **Where to ask what** — [`SUPPORT.md`](./SUPPORT.md).
- **Contributor conduct** — [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
- **How to contribute** — [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

Licensed under the [Apache License 2.0](./LICENSE).

The upstream `mudit70/adorable` project shipped under the MIT License.
See [`CHANGELOG.md`](./CHANGELOG.md) for the license-decision provenance
recorded during the 2026-06-30 open-source readiness review.
