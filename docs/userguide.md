# Veoable — User Guide

Veoable analyzes your codebase and builds a queryable graph of end-to-end flows:
**UI handler → API call → backend endpoint → service/handler → database read/write
→ response → DOM update.** You then point an AI assistant (Claude, Cursor, any
MCP-compatible client) at that graph so it can answer questions like *"what
happens when a user clicks the login button?"* with grounded, traversed answers
instead of guesses.

This guide takes you from zero to "Claude answers questions about my codebase"
in under 10 minutes, then covers every flag and workflow you'll need after that.

---

## Table of contents

1. [Install](#install)
2. [The 60-second tour](#the-60-second-tour)
3. [The mental model](#the-mental-model)
4. [Framework coverage](#framework-coverage)
5. [Single-repo analysis](#single-repo-analysis)
6. [Multi-repo projects](#multi-repo-projects)
7. [Live updates with `project watch`](#live-updates-with-project-watch)
8. [Connecting Claude / Cursor / other MCP clients](#connecting-claude--cursor--other-mcp-clients)
9. [REST API and the `chat` command](#rest-api-and-the-chat-command)
10. [Worked example: analyzing an OSS repo](#worked-example-analyzing-an-oss-repo)
11. [Troubleshooting](#troubleshooting)
12. [Command reference](#command-reference)

---

## Install

Requires **Node.js 20+** and **pnpm**.

```bash
git clone https://github.com/mudit70/adorable
cd adorable
git checkout v0.3.0      # or main for the bleeding edge
pnpm install
pnpm install-cli         # exposes `adorable` on your $PATH
```

Verify:

```bash
adorable --help
```

If `adorable: command not found`, your shell's PATH doesn't see pnpm's global
bin directory. Run `pnpm bin --global` and add that path to your shell rc.

---

## The 60-second tour

Inside any TypeScript / Python / Go / Java / PHP / Rust project:

```bash
cd ~/code/my-app
adorable analyze . --output graph.db
```

You'll see something like:

```
Discovering source files in /Users/me/code/my-app...
  ✓ found 312 files across 1 language(s): ts
── Analyzing my-app ──
  ✓ 312 files extracted
  ✓ stitched 47 end-to-end flows
── Analysis complete ──
Output: /Users/me/code/my-app/graph.db (2.4 MB)
```

You now have a SQLite file containing every endpoint, function, DB table, and
the call edges between them. Use it three ways:

```bash
# 1. Inspect from the terminal (good for a sanity check).
adorable analyze . --format json | jq '.flows[:5]'

# 2. Serve to an MCP client (Claude Desktop, Claude Code, Cursor).
adorable serve graph.db

# 3. Chat with an LLM that already knows how to query the graph.
#    The CLI resolves the API key from --api-key, then $OPENROUTER_API_KEY,
#    then $OPENAI_API_KEY — set whichever fits your provider.
adorable chat graph.db --model anthropic/claude-sonnet-4 --api-key $OPENROUTER_API_KEY
```

The MCP path (#2) is what most people want — see
[Connecting Claude / Cursor / other MCP clients](#connecting-claude--cursor--other-mcp-clients).

---

## The mental model

The graph is a typed set of **nodes** connected by typed **edges**.

**Nodes** you'll see most:

| Node                  | What it represents                                                |
| --------------------- | ----------------------------------------------------------------- |
| `SourceFile`          | One file on disk                                                  |
| `FunctionDefinition`  | One function/method                                               |
| `APIEndpoint`         | Server-side HTTP route (`GET /users/:id`)                         |
| `ClientSideAPICaller` | Client-side outbound call (`fetch('/users/' + id)`)               |
| `ClientSideProcess`   | DOM handler (`onClick`, form `onSubmit`, screen `onPress`)        |
| `StateStore`          | Redux/Zustand/MobX store, RTK slice, Vuex module                  |
| `DatabaseSystem`      | A Prisma client, Drizzle DB, Mongoose connection, Django ORM root |
| `DatabaseTable`       | A `users` table, a `posts` collection                             |
| `DatabaseColumn`      | A column or document field                                        |

**Edges** carry the flow:

| Edge                   | Meaning                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `DEFINED_IN`           | function → file it lives in                                        |
| `IMPORTS`              | file → file                                                        |
| `CALLS_FUNCTION`       | function → function                                                |
| `RESOLVES_TO_ENDPOINT` | `ClientSideAPICaller` → `APIEndpoint` (the load-bearing stitch)    |
| `READS` / `WRITES`     | function → `DatabaseTable`                                         |
| `TRIGGERS`             | `ClientSideProcess` → function (UI handler invokes business logic) |

A "flow" is just a path through this graph. The `stitch` step finds them by
matching each `ClientSideAPICaller` to the server-side `APIEndpoint` whose
method + path template it would hit at runtime.

### Non-HTTP entry points use marker `httpMethod` values

Veoable models task queues, gRPC services, WebSockets, and MCP tool
registrations as `APIEndpoint` nodes too — the schema doesn't grow a new
node type per category. Instead, the `httpMethod` field carries a marker:

| Marker  | What it represents                                       | Plugins                                       |
| ------- | -------------------------------------------------------- | --------------------------------------------- |
| `JOB`   | Task-queue consumer (BullMQ, Celery, Asynq, Apalis)      | framework-bullmq / -celery / -asynq / -apalis |
| `GRPC`  | gRPC RPC method on a service                             | framework-grpc-node / -grpcio / -grpcgo / -tonic |
| `WS`    | WebSocket server endpoint                                | framework-ws-ts / -ws-py / -ws-go / -ws-rs    |
| `TOOL`  | MCP server tool registration                             | framework-mcp-server / -mcp-server-rust       |

The `routePattern` carries a scheme prefix that mirrors the marker — e.g.
`mcp:get_user`, `grpc:Greeter/SayHello`, `ws:/api/notifications`,
`kafka:orders.created`. The same prefixes appear on `ClientSideAPICaller`
nodes for outbound calls so stitching works across categories. Cloud-storage
and AWS-service calls use their own schemes: `s3://<bucket>/<key>`,
`dynamodb://<table>/`, `sqs:<queue>`, `sns:<topic>`, `lambda:<fn>`,
`gs://<bucket>/<obj>`, `azure://<container>/<blob>`.

### `detectedPlugins` vs `emittingPlugins`

Every analyze result reports two plugin lists:

- `detectedPlugins` — every plugin whose activation gate fired. Some
  plugins activate on weak signals (a `vite.config.ts` file present, the
  Go stdlib being available, any `fetch()` reference) and won't always
  produce nodes.
- `emittingPlugins` — the subset that actually contributed at least one
  node to the graph. This is the "working set" — what your stack is
  *really* exercising.

`adorable analyze` prints the emitting list as the headline `Frameworks:`
line and surfaces silent activations on a separate `(detected, silent: ...)`
line, so you can tell "this plugin saw your stack" apart from "this
plugin produced real graph content."

---

## Framework coverage

Veoable ships 114+ framework plugins covering TypeScript / JavaScript,
Python, Go, and Rust, plus partial Java and PHP support. Each plugin
activates by reading its language's manifest (`package.json` /
`requirements.txt` / `go.mod` / `Cargo.toml`) and matching specific call
shapes inside your source.

The cross-category, cross-language matrix:

| Category               | TypeScript / JavaScript                                                                    | Python                                              | Go                                          | Rust                                          |
| ---------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Web server             | nextjs, express, koa, hapi, fastify, hono, nestjs, remix                                   | django, flask, fastapi, aiohttp, tornado            | gin, chi, echo, fiber, gohttp               | axum, actix, rocket, warp, poem               |
| Web frontend           | react, react-native, react-router, vue, angular, svelte, dom, redirects, state-mgmt, bundler | —                                                   | —                                           | —                                             |
| HTTP client            | fetch, axios                                                                               | httpx                                               | gohttp                                      | reqwest                                       |
| RPC client             | rpc-client, trpc                                                                           | —                                                   | —                                           | —                                             |
| SQL ORM                | prisma, drizzle, knex, sequelize, typeorm, mikroorm                                        | sqlalchemy, sqlmodel, peewee, tortoise              | gorm, gosqlx, ent                           | sqlx, diesel, seaorm                          |
| NoSQL (MongoDB)        | mongoose                                                                                   | pymongo                                             | mongogo                                     | mongorust                                     |
| KV (Redis)             | ioredis                                                                                    | redispy                                             | goredis                                     | redisrs                                       |
| KV (Memcached)         | memcache-ts                                                                                | memcache-py                                         | memcache-go                                 | memcache-rs                                   |
| Object storage (S3)    | aws-s3-ts                                                                                  | boto3                                               | awsgo-s3                                    | awsrust-s3                                    |
| Object storage (GCS)   | gcs-ts                                                                                     | gcs-py                                              | gcs-go                                      | gcs-rs                                        |
| Object storage (Azure) | azure-blob-ts                                                                              | azure-blob-py                                       | azure-blob-go                               | azure-blob-rs                                 |
| Messaging (Kafka)      | kafkajs                                                                                    | kafkapy                                             | kafkago                                     | kafkars                                       |
| Messaging (RabbitMQ)   | amqplib                                                                                    | pika                                                | amqp091-go                                  | lapin                                         |
| Task queue             | bullmq                                                                                     | celery                                              | asynq                                       | apalis                                        |
| WebSocket              | ws-ts                                                                                      | ws-py                                               | ws-go                                       | ws-rs                                         |
| Elasticsearch          | elastic-ts                                                                                 | elastic-py                                          | elastic-go                                  | elastic-rs                                    |
| gRPC                   | grpc-node                                                                                  | grpcio                                              | grpcgo                                      | tonic                                         |
| MCP server             | mcp-server                                                                                 | —                                                   | —                                           | mcp-server-rust                               |
| CLI                    | —                                                                                          | pycli                                               | gocli                                       | rustcli                                       |
| Async runtime          | —                                                                                          | —                                                   | —                                           | tokio-spawn                                   |
| GraphQL                | graphql                                                                                    | —                                                   | —                                           | —                                             |
| Edge / serverless      | supabase                                                                                   | —                                                   | —                                           | —                                             |

JVM (Spring, JPA) and PHP (Laravel) plugins are included but their
ecosystems aren't covered to the same breadth as the TS/Py/Go/Rust core.

**AWS service expansion**: the four `*-s3` plugins (`aws-s3-ts`,
`boto3`, `awsgo-s3`, `awsrust-s3`) also detect DynamoDB, SQS, SNS, and
Lambda Invoke calls — each service surfaces under its own framework
label (`boto3-dynamodb`, `awsgo-sqs`, etc.) and URL scheme.

When the analyzer can't see a plugin firing in your codebase, that's
working as designed — the activation gates are deliberately conservative.
If you expect a plugin and don't see it, check that its manifest entry
is present at the analysis root (or in a subpackage manifest, if you're
analyzing a monorepo — Veoable reads every nested manifest under
`rootDir` for activation).

---

## Single-repo analysis

```bash
adorable analyze <path> [options]
```

The defaults are sensible. Common flags:

```bash
# Persist to disk (without --output the graph is in-memory and lost on exit).
adorable analyze . --output graph.db

# JSON output (pipe to jq, grep, etc).
adorable analyze . --format json > flows.json

# Show per-file extraction progress.
adorable analyze . --verbose

# Override the repo name (defaults to the directory name).
adorable analyze ./backend --output graph.db --repo-name api

# Wipe just this repo's nodes from an existing graph before re-analyzing.
adorable analyze ./backend --output graph.db --repo-name api --clean

# Wipe the entire DB and start fresh.
adorable analyze . --output graph.db --fresh

# Incremental: re-extract only files whose content changed since last run.
adorable analyze . --output graph.db --incremental
```

### `--clean` vs `--fresh` vs `--incremental`

| Flag             | Scope                | When to use                                                   |
| ---------------- | -------------------- | ------------------------------------------------------------- |
| `--clean`        | This repo only       | Re-analyzing one repo inside a multi-repo DB                  |
| `--fresh`        | The entire DB file   | "Start over from scratch"                                     |
| `--incremental`  | This repo only       | Repeated analysis on the same code with a few edits in between |

`--fresh` wins over `--incremental` (they coexist but the DB is wiped first).
`--clean` and `--incremental` are independent — clean wipes the repo, then
incremental records the new hashes.

### Output formats

```bash
adorable analyze . --format text   # default — readable flow summary
adorable analyze . --format json   # full graph + flows as JSON
```

### Memory

ts-morph loads every TS file into a single project for cross-file resolution.
On large repos (~5k+ TS files) this needs a bigger V8 heap. Veoable
auto-respawns Node with `--max-old-space-size=8192` (8 GB) the first time it
starts. Override:

```bash
ADORABLE_HEAP_MB=12288 adorable analyze .   # 12 GB
ADORABLE_NO_HEAP_BUMP=1 adorable analyze .  # skip the auto bump
```

---

## Multi-repo projects

Most real apps are multiple repos: a frontend, a backend, maybe a shared
package. Veoable analyzes each repo independently and stitches across them.

> **A note on monorepos.** Veoable also handles a single repo that
> internally has per-package `tsconfig.json` files (the typebot.io /
> cal.com / dub / papermark shape). In that case you can just point
> `adorable analyze` at the repo root — the language plugin walks every
> subpackage's source into a single project. If the root `tsconfig.json`
> uses `references: [./apps/x]` to delegate to subpackage configs,
> Veoable trusts the reference graph and does not sweep further. If
> the references are missing or the subpackage tsconfig is opaque, it
> falls back to a full rootDir sweep. Either way, you don't usually
> need to write a `.project.json` — that's for genuinely separate
> repos that should each get their own analysis pass before cross-repo
> stitching.

### 1. Bootstrap a config

```bash
adorable project init ~/code/myapp
```

This walks the directory, finds likely repo roots, asks you to confirm, and
writes a `myapp.project.json` next to your monorepo:

```json
{
  "name": "myapp",
  "output": "myapp.db",
  "repos": [
    { "path": "./frontend", "name": "frontend" },
    { "path": "./backend",  "name": "backend"  },
    { "path": "./shared",   "name": "shared"   }
  ],
  "stitchMode": "auto-exact"
}
```

Notes on the fields:

- `output` — path to the SQLite file (relative to the config file's directory).
- `repos[].path` — relative to the config file.
- `stitchMode`:
  - `"auto-exact"` (default) — only stitch when the URL template matches exactly.
  - `"auto-all"` — also stitch fuzzy matches; useful when you have URL builders.
  - `"none"` — no automatic stitching; only your manually-listed `stitchRules`.

### 2. Run the full analysis

```bash
adorable project analyze myapp.project.json --verbose
```

You get per-repo progress, then global cross-repo stitching, then a summary
of any unresolved callers + suggested stitch rules.

### 3. Iterate

Edit some code; re-run:

```bash
adorable project analyze myapp.project.json --incremental
```

Only files with changed SHA-256 hashes get re-extracted. On a 700-file project
this typically takes 4–5 seconds instead of 20–30.

To nuke everything and start over:

```bash
adorable project analyze myapp.project.json --fresh
```

---

## Live updates with `project watch`

Instead of re-running `project analyze` after each edit, leave a watcher
running:

```bash
adorable project watch myapp.project.json --incremental --on-demand
```

What you see:

```
Watching 3 repo(s) — frontend, backend, shared
Mode: on-demand (press 'r' in terminal to refresh, or call refreshNow()); output DB: /path/to/myapp.db
Press 'r' to refresh, 'q' or Ctrl-C to quit.
```

Now edit code in any of those repos. The watcher silently tracks which repos
have dirty files. When you're ready to ask Claude something:

```
[you press r]
  [1/2] backend…
  [1/2] ✓ backend (3.4s)
  [2/2] frontend…
  [2/2] ✓ frontend (1.1s)
✓ refreshed backend, frontend (4.6s)
```

Your MCP/Claude session sees the updated graph on its next question — no
restart needed.

### Flag combinations

| Combination                          | Behavior                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------- |
| (no flags)                           | Auto-refresh after every save (1 s debounce). Full re-extract per cycle.    |
| `--incremental`                      | Auto-refresh, but only changed files re-extract.                            |
| `--on-demand`                        | Track changes, never auto-refresh. Press `r` to trigger a full re-extract.  |
| `--incremental --on-demand`          | **Recommended for large repos.** Track + press `r` for a fast diff refresh. |

### Other watch flags

```bash
--debounce 500    # ms between change events and auto-refresh (default 1000)
--verbose         # per-file extraction progress on each cycle
```

### How incremental decides what to re-extract

1. Read SHA-256 hash for each source file currently on disk.
2. Compare against `source_file_hashes` table in the SQLite DB.
3. Mark each differing file as "changed."
4. For each changed TypeScript file, find every file that imports it (1-hop
   reverse-import cascade) and mark those changed too — their `IMPORTS` edges
   need to be rebuilt against the changed target.
5. **Cap:** two thresholds gate this, and **either** trips a fallback to a
   full repo re-extract (cheaper than orchestrating hundreds of single-file
   extracts, plus bounded):
   - absolute count cap of 100 files (env override: `ADORABLE_MAX_CASCADE_FILES=200`);
   - ratio cap of 30% of discovered files.
   In practice the smaller cap dominates — the absolute cap on a large repo,
   the ratio cap on a small one.

If the canonical schema version in the hash sidecar doesn't match the running
Veoable's schema, the whole sidecar is invalidated and a full re-extract
runs.

---

## Connecting Claude / Cursor / Continue / VS Code

The fastest path is `adorable install <client>` (or `--auto`). It writes
the canonical Veoable skill into the client's expected location so the
agent recognizes when to invoke Veoable's MCP tools without you having
to explain it. The full reference — flags, paths, troubleshooting,
removal — lives in [**docs/llm-client-install.md**](llm-client-install.md).

```bash
# One command, every client we detect on your machine:
cd ~/my-project
adorable install --auto --db my-project.db

# Or pick one explicitly:
adorable install claude-code
adorable install cursor    --db my-project.db
adorable install continue  --db "$PWD/my-project.db"
adorable install vscode    --db my-project.db
```

After install, restart the client (fully quit, not just close the window).
You'll see Veoable's tools surface — Claude Code prints "🔧 tool:
list_repositories", Cursor shows a 🛠️ chip, etc. Ask a question that
matches the skill's triggers and the agent routes the call:

> *"What happens when a user submits the new-post form?"*
>
> *"Show me every code path that writes to the `users.email` column."*
>
> *"Why is the `/api/orders` endpoint slow? Walk me through it."*

### What `adorable install` writes per client

| Client       | Scope         | Files written                                                                                       |
| ------------ | ------------- | --------------------------------------------------------------------------------------------------- |
| claude-code  | user          | `~/.claude/skills/adorable/SKILL.md`                                                                |
| cursor       | project       | `.cursor/rules/adorable.mdc` + (with `--db`) `.cursor/mcp.json` merge                               |
| continue     | user          | `~/.continue/config.json` merge — `/adorable` slash command + (with `--db`) `mcpServers` entry      |
| vscode       | project       | `.github/copilot-instructions.md` delimited section + (with `--db`) `.vscode/mcp.json` merge        |

Every adapter is idempotent — re-running with the current Veoable
version refreshes the skill content; existing client-specific config
outside Veoable's section is preserved.

### Manual MCP setup (no `adorable install`)

If you prefer to wire things up by hand (e.g. for a client we don't yet
support, or for Claude Desktop), the MCP server entry shape is uniform
across MCP clients:

```json
{
  "mcpServers": {
    "adorable": {
      "command": "adorable",
      "args": ["serve", "/absolute/path/to/myapp.db"]
    }
  }
}
```

For Claude Desktop: Settings → Developer → Edit Config, add the entry
above, restart. For any other MCP client: drop the same shape into the
client's config (some use `servers` instead of `mcpServers` — see VS
Code in the install guide).

Some clients prefer the HTTP transport:

```bash
adorable serve myapp.db --transport http --port 3001
# Then point the client at http://localhost:3001
```

### Recommended workflow

Run `project watch --incremental --on-demand` in one terminal. Leave
Claude/Cursor/Copilot open. When you edit code, press `r` in the watch
terminal before asking your next question — the graph reflects your
latest edits.

---

## REST API and the `chat` command

If you don't want MCP, two alternatives:

### Plain REST

```bash
adorable serve myapp.db --rest --port 3001
```

The REST server exposes the same tools as MCP, on two routes:

- `GET  /api/tools` — list every tool with its OpenAI-style schema.
- `POST /api/tools/:toolName` — invoke a tool. Body is JSON; the schema's
  `parameters` object describes the expected fields.

The discovery endpoint returns `{ "tools": [{ "type": "function", "function": { "name", "description", "parameters" } }, …] }`. Each tool invocation returns `{ "result": … }`.

```bash
# Discover what's available.
curl http://localhost:3001/api/tools | jq '.tools[] | .function.name'

# List every server-side HTTP endpoint.
curl -X POST http://localhost:3001/api/tools/list_server_endpoints \
     -H 'Content-Type: application/json' \
     -d '{}' | jq '.result'

# List endpoints filtered by HTTP method.
curl -X POST http://localhost:3001/api/tools/list_server_endpoints \
     -H 'Content-Type: application/json' \
     -d '{"method": "POST"}' | jq '.result'

# Get one source file's contents (needs --project-root on the server).
curl -X POST http://localhost:3001/api/tools/get_source_file \
     -H 'Content-Type: application/json' \
     -d '{"file_path": "src/api/users.ts"}' | jq '.result'
```

`adorable tools` from the CLI prints the same list with each parameter
documented.

### Built-in chat

```bash
# OpenRouter — recommended quickstart (no LLM-client install required):
adorable chat myapp.db --provider openrouter --model anthropic/claude-sonnet-4
# (with $OPENROUTER_API_KEY set in your env or .env)

# OpenAI:
adorable chat myapp.db --provider openai --model gpt-4o

# Local Ollama:
adorable chat myapp.db --model llama3
```

You type questions, the chat loop hands them to the LLM with the graph tools
attached. Faster to demo than wiring up Claude Desktop, but the desktop
experience is better for sustained work.

See [Using OpenRouter (or any OpenAI-compatible endpoint)](#using-openrouter-or-any-openai-compatible-endpoint)
below for the full set of options and how MCP-client installs interact with
OpenRouter.

---

## Using OpenRouter (or any OpenAI-compatible endpoint)

[OpenRouter](https://openrouter.ai/) is a unified API that routes a single key
to dozens of LLM providers. It's the **fastest path to try Veoable** if you
don't already have Claude Desktop / Cursor / a local Ollama, because
`adorable chat` works against it directly — no MCP client setup, no
desktop-app config files.

### Quickstart

```bash
export OPENROUTER_API_KEY=sk-or-...
adorable project init ~/my-project
adorable project analyze my-project.project.json
adorable chat my-project.db --provider openrouter --model anthropic/claude-sonnet-4
```

That's the whole loop: analyze, chat. The `--provider openrouter` shortcut
fills in the OpenRouter base URL and tells the chat loop where to look for
the API key.

### Other supported providers

The same `--provider` shortcut covers OpenAI directly, Anthropic's
OpenAI-compatible shim, and local Ollama:

| `--provider` | `--llm` URL                       | API-key env var       |
| ------------ | --------------------------------- | --------------------- |
| `openrouter` | `https://openrouter.ai/api/v1`    | `OPENROUTER_API_KEY`  |
| `openai`     | `https://api.openai.com/v1`       | `OPENAI_API_KEY`      |
| `anthropic`  | `https://api.anthropic.com/v1`    | `ANTHROPIC_API_KEY`   |
| `local`      | `http://localhost:11434` (Ollama) | `OLLAMA_API_KEY`      |

For a self-hosted OpenAI-compatible proxy, skip `--provider` and pass `--llm`
explicitly:

```bash
adorable chat my-project.db --llm https://llm.mycompany.com/v1 --model my-model
```

Explicit `--llm` always wins over `--provider`'s URL, so you can combine the
two — e.g., `--provider openrouter` for the API key and a custom `--llm` URL
for a proxy.

### What about MCP clients (Cursor, Continue, Claude Code, VS Code)?

`adorable install <client>` writes the canonical SKILL.md into the client's
config — it doesn't pick the LLM the client uses to think. That's the
client's own setting:

- **Cursor** — Cursor's own model picker, in Settings → Models →
  OpenAI-API-Compatible. Point at OpenRouter's Cursor-specific endpoint
  `https://openrouter.ai/api/v1/cursor` (note the `/cursor` suffix —
  the generic `/api/v1` won't work because Cursor's request format
  needs server-side adaptation). See OpenRouter's
  [Cursor integration cookbook](https://openrouter.ai/docs/cookbook/coding-agents/cursor-integration)
  for the up-to-date steps.
- **Continue** — Continue has native OpenRouter provider support in its
  config: `models: [{ provider: "openrouter", model: "...", apiKey: "..." }]`.
- **Claude Code** — uses your Anthropic subscription directly, not
  OpenRouter.
- **VS Code Copilot Chat** — uses your GitHub Copilot subscription
  directly, not OpenRouter.

So for Cursor and Continue you can `adorable install <client>` once and
configure OpenRouter in the client separately. For Claude Code and VS Code
Copilot, `adorable chat` is the OpenRouter path; the install adapters there
assume their native backend.

---

## Worked example: analyzing an OSS repo

Let's analyze a real project: [rallly](https://github.com/lukevella/rallly)
(a Next.js + Prisma scheduling app).

```bash
# 1. Clone.
git clone https://github.com/lukevella/rallly ~/code/rallly
cd ~/code/rallly
pnpm install

# 2. Bootstrap an Veoable config.
adorable project init .

# When prompted, accept the discovered repos (it'll find the Next.js app +
# every package under packages/).

# 3. First analysis.
adorable project analyze rallly.project.json --verbose
# Takes ~8 seconds on a fresh machine.

# 4. Start a watch + serve loop.
#    Terminal A:
adorable project watch rallly.project.json --incremental --on-demand
#    Terminal B (or hook into Claude Desktop, see above):
adorable serve rallly.db --rest --port 3001 --project-root ~/code/rallly

# 5. Ask questions.
# List every POST endpoint.
curl -X POST http://localhost:3001/api/tools/list_server_endpoints \
     -H 'Content-Type: application/json' \
     -d '{"method": "POST"}' | jq '.result[] | .path'

# Show the source for a specific handler.
curl -X POST http://localhost:3001/api/tools/get_source_file \
     -H 'Content-Type: application/json' \
     -d '{"file_path": "apps/web/src/pages/api/auth/login-token.ts"}' | jq '.result'

# Find every incomplete flow (client call with no resolved endpoint).
curl -X POST http://localhost:3001/api/tools/list_incomplete_flows \
     -H 'Content-Type: application/json' \
     -d '{}' | jq '.result'
```

When you edit a file in the rallly tree, press `r` in Terminal A. The next
`curl` (or Claude question) sees the new graph.

---

## Troubleshooting

### "Heap out of memory" during analyze

Bump the heap:

```bash
ADORABLE_HEAP_MB=16384 adorable analyze .
```

If it still fails, your project is too big for a single ts-morph project.
Split it via `project init` into sub-repos at package boundaries; each
sub-repo loads its own ts-morph project.

### Watch loop misses changes on macOS

`chokidar` uses `fsevents`. Some editors (especially when using safe-write)
emit `unlink` + `add` instead of `change`. Both are handled, but you can
sanity-check with `--verbose` — every detected event prints.

If a particular repo never appears dirty, check the `IGNORED_DIRS` list
(`packages/cli/src/watch.ts`): `node_modules`, `dist`, `build`, `out`,
`.git`, `.next`, `.nuxt`, `coverage`, `__pycache__`, `.venv`, `venv`,
`target`, `vendor` are always skipped.

### "Schema version drift detected" on incremental

Your `source_file_hashes` sidecar was written by a previous Veoable build
with a different canonical schema. Veoable auto-falls-back to a full
re-extract for that repo and rebuilds the sidecar. One free cycle, no
action needed.

### Stale edges after a symbol rename

The 1-hop reverse-import cascade catches direct importers but not transitive
ones. If you rename `handlers.ts:fn` and `app.ts` imports it via a re-export
through `barrel.ts`, `app.ts`'s edge will be stale until you either:

- Touch `app.ts` (any whitespace change works), or
- Run `adorable project analyze --fresh`.

### `RangeError: Maximum call stack size exceeded`

Unrelated to heap — this is a real recursion bug. File an issue with the
file path that triggered it.

### Tools/MCP — "no tools shown" in Claude Desktop

Claude Desktop caches the MCP server on a startup. After `adorable serve`
changes, fully quit (not just close) and reopen.

---

## Command reference

Each command has its own detailed help:

```bash
adorable analyze --help
adorable serve --help
adorable chat --help
adorable project init --help
adorable project analyze --help
adorable project watch --help
adorable tools --help
```

### Environment variables

| Variable                          | Default      | Purpose                                          |
| --------------------------------- | ------------ | ------------------------------------------------ |
| `ADORABLE_HEAP_MB`                | `8192`       | V8 old-space heap budget (MB)                    |
| `ADORABLE_NO_HEAP_BUMP`           | unset        | Set to `1` to skip the auto heap respawn         |
| `ADORABLE_MAX_CASCADE_FILES`      | `100`        | Cap for the incremental reverse-import cascade   |
| `ADORABLE_MAX_EXTRA_PATH_TARGETS` | `250`        | TS path-mapped target directories to preload     |
| `NODE_OPTIONS`                    | unset        | Respected; disables the auto heap bump if set    |

### Project config schema

A full annotated config:

```jsonc
{
  // Display name; appears in logs and the chat banner.
  "name": "myapp",

  // SQLite output file, relative to this config file's directory.
  "output": "myapp.db",

  // Repos to analyze, in order. Each gets its own per-repo extraction
  // pass. Cross-repo stitching runs after all repos finish.
  "repos": [
    { "path": "./frontend", "name": "frontend" },
    { "path": "./backend",  "name": "backend"  }
  ],

  // Stitching strategy.
  //   "auto-exact" — match only when URL templates exactly equal.
  //   "auto-all"   — also try fuzzy matches (URL-builder helpers).
  //   "none"       — only apply manual stitchRules below.
  "stitchMode": "auto-exact",

  // Optional manual stitches for cases where automatic matching can't
  // see the connection (e.g., URL built from constants at runtime).
  "stitchRules": [
    {
      "description": "POST /v1/feed -> backend feed.create",
      "callerPrefix": "frontend:src/api/feed.ts",
      "endpointId": "ep_backend_feed_create"
    }
  ],

  // Optional application scopes for graph queries — most users skip this.
  "applications": [
    { "name": "consumer-app", "frontendRepos": ["frontend"], "backendRepos": ["backend"] }
  ]
}
```

---

## Where to go next

- **[`docs/llm-client-install.md`](llm-client-install.md)** — full reference
  for `adorable install <client>` (Claude Code, Cursor, Continue, VS Code,
  `--auto`). Includes per-client paths, the `--db` flag semantics,
  verifying the install, updating, removing, and troubleshooting.
- **[`docs/mcp-tools-guide.md`](mcp-tools-guide.md)** — what every MCP tool
  does and the developer questions it answers. The companion to this guide
  for anyone using Veoable with an AI assistant.
- **`docs/architecture.md`** — how Veoable parses, what plugins do, how
  stitching is implemented.
- **`docs/MCPInteractionBestPractices.md`** — patterns for prompting an
  AI assistant against the graph.
- **`docs/cross-boundary-stitching.md`** — the algorithm that connects
  client-side calls to server-side endpoints.
- **`README.md`** + GitHub issues — the latest in-flight work.
