# Veoable

> **Renaming in progress.** Veoable is the new home for a project previously
> released as [`adorable`](https://github.com/mudit70/adorable). Package
> namespaces are moving from `@veoable/*` to `@veoable/*`, the CLI is being
> renamed from `adorable` to `veoable`, and the source tree is being
> republished here as `mudit70/veoable`. Tracking issue:
> [`mudit70/adorable#516`](https://github.com/mudit70/adorable/issues/516).
>
> This repository currently contains only the community-facing artifacts
> (README, CONTRIBUTING, SECURITY, CI). The source drop lands in a
> follow-up mechanical-rename PR that migrates the ~130-package workspace
> from `@veoable/*` to `@veoable/*`.

## What Veoable does

Veoable takes code — written by humans or by AI — and analyzes it in
explainable ways. It builds a list of every API endpoint, client-side API
caller, and UI interaction element across the screens of an application,
then **stitches them into end-to-end flows** so you can see what actually
happens when a user clicks a button: the initial handler, the API calls,
the database interactions, the response, the DOM update. That compressed
context grounds an AI assistant when you're debugging, fixing, or changing
anything in the flow.

## Coverage at a glance

**Languages:** TypeScript / JavaScript, Python, Go, Rust, plus Java
(Spring / JPA) and PHP (Laravel).

**Framework families (114+ plugins):** web servers (Next.js, Express,
NestJS, Django, FastAPI, Flask, Gin, Echo, Axum, Actix, …), HTTP clients
(fetch, axios, httpx, reqwest, …), SQL ORMs (Prisma, Drizzle, SQLAlchemy,
GORM, SQLx, Diesel, …), NoSQL & KV (Mongoose, PyMongo, ioredis, …), object
storage (S3 / GCS / Azure Blob across all four languages), messaging
(Kafka, RabbitMQ, BullMQ, Celery, Asynq, Apalis), WebSockets,
Elasticsearch, gRPC, MCP servers, plus React / Vue / Angular / Svelte on
the frontend.

## Architecture invariants

Two load-bearing rules — expected of every contribution:

1. **Split parsers by language, not by framework.** One `LanguagePlugin` per
   language owns the AST walk (`lang-ts`, `lang-py`, `lang-go`, …). All
   `FrameworkPlugin`s targeting that language register visitors that share
   the single walk. A framework plugin must **never** instantiate its own
   parser (`new Project()` from ts-morph, `libcst`, `tree-sitter`, …) for
   source files in that language. If you find yourself wanting to, extend
   the LanguagePlugin's visitor context with a helper so every framework
   plugin benefits.
   *Sanctioned exception:* `FrameworkPlugin.onProjectLoaded` may parse
   files the language plugin does not claim (Prisma schemas, Django
   models, OpenAPI specs, webpack configs).

2. **Split graphs by repository.** Multi-repo projects analyze each repo
   independently and stitch results in the flow-stitcher layer. Don't
   share AST state across repos.

Cross-cutting concerns (cross-file symbol resolution, manifest discovery,
constant propagation, workspace-alias resolution) belong in the language
plugin or in `plugin-api`, **not** duplicated across framework plugins.
Three frameworks each implementing the same resolution logic is a smell —
extract it down one layer.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for how to build, test, and
propose changes.

## Get started

> These instructions temporarily reference the adorable source. Once the
> mechanical-rename PR lands, replace `adorable` / `@veoable/*` with
> `veoable` / `@veoable/*`.

Requires **Node.js 20+** and **pnpm 10**.

```bash
git clone https://github.com/mudit70/adorable
cd adorable
git checkout v0.3.0
pnpm install
pnpm install-cli
```

See the [User Guide](https://github.com/mudit70/adorable/blob/main/docs/userguide.md)
and the [LLM Client Install Guide](https://github.com/mudit70/adorable/blob/main/docs/llm-client-install.md)
for the 60-second tour, MCP setup, and the recommended
`project watch --incremental --on-demand` workflow on large repositories.

## Project status

- ✅ Community-facing artifacts (this README, CONTRIBUTING, SECURITY, CoC,
  issue + PR templates, GitHub Actions CI).
- ⏳ Mechanical-rename PR — `@veoable/*` → `@veoable/*` across ~622 files.
- ⏳ npm publication of `@veoable/*` packages (with `--provenance`).
- ⏳ Migration command: `npx @veoable/migrate-from-adorable`.
- ⏳ Deprecation of `@veoable/*` packages with pointers here.

Follow [`mudit70/adorable#516`](https://github.com/mudit70/adorable/issues/516)
for the full sequencing.

## Community

- **Bug reports & feature requests:** open a new issue (templates provided).
- **Security disclosures:** see [`SECURITY.md`](./SECURITY.md).
- **Questions & discussion:** see [`SUPPORT.md`](./SUPPORT.md).
- **Contributor conduct:** [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## License

Licensed under the [Apache License 2.0](./LICENSE).
