# Veoable -- Status Update and User Guide

**Date:** April 9, 2026

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Package Reference](#package-reference)
4. [Project Statistics](#project-statistics)
5. [Getting Started](#getting-started)
6. [CLI Usage](#cli-usage)
7. [MCP Server -- AI Agent Integration](#mcp-server----ai-agent-integration)
8. [Programmatic API](#programmatic-api)
9. [Running Tests](#running-tests)
10. [Supported Stack](#supported-stack)
11. [Issues Closed](#issues-closed)
12. [Known Limitations and Open Issues](#known-limitations-and-open-issues)
13. [Future Framework Support](#future-framework-support)

---

## Project Overview

Veoable analyzes AI-written code to build explainable end-to-end flows. It discovers API endpoints, client-side API callers, UI interaction elements (processes), and database interactions across a codebase, then stitches them together so a user can see what happens when they invoke a user interaction -- all the way from the initial handler through API calls to database interactions and back.

This compressed context can be used to get more accurate results from AI when debugging, fixing, or changing anything related to the flow.

### How it works

1. Scans source files and builds a knowledge graph of structural elements (functions, imports, exports, call sites).
2. Detects framework-specific nodes: React event handlers, Express routes, Prisma models, fetch calls.
3. Stitches client-side API callers to server-side endpoints via URL matching.
4. Walks the graph to produce end-to-end flows from UI interaction through API layer to database.
5. Exposes the results via CLI output, JSON, or an MCP server for AI agent consumption.

---

## Architecture

Veoable is a **pnpm monorepo** consisting of **16 TypeScript ESM packages**, organized into five layers.

```
                         +-------------------+
                         |    @veoable/cli   |   CLI entry point
                         +-------------------+
                                  |
              +-------------------+-------------------+
              |                                       |
    +-------------------+                   +-------------------+
    | @veoable/mcp-server |                | @veoable/flow-stitcher |
    +-------------------+                   +-------------------+
              |                                       |
              +-------------------+-------------------+
                                  |
         +----------------+----------------+----------------+
         |                |                |                |
  +-----------+   +-----------+   +-----------+   +-----------+
  | framework |   | framework |   | framework |   | framework |
  |  -prisma  |   |  -react   |   |  -express |   |  -fetch   |
  +-----------+   +-----------+   +-----------+   +-----------+
                         |
                  +-----------+
                  | lang-ts   |   Language plugin
                  +-----------+
                         |
    +--------+--------+--------+--------+--------+
    |        |        |        |        |        |
 schema  plugin-api  observability  graph-db   core
```

---

## Package Reference

### Foundational Packages

| Package | Purpose |
|---------|---------|
| `@veoable/schema` | Canonical knowledge graph schema (Zod). Single source of truth for every node type and edge type. Content-addressed IDs via `idFor.*` helpers. Runtime validators. `SCHEMA_VERSION` constant. |
| `@veoable/plugin-api` | Plugin contract: `LanguagePlugin`, `FrameworkPlugin` (with optional `onProjectLoaded` hook), `FrameworkVisitor` interfaces, `BatchMeta`, `NodeBatch` types. Types only, zero runtime logic. |
| `@veoable/observability` | OpenTelemetry wrapper. `withSpan` for tracing, `recordConfidenceDecision` for the hard rule that every dynamic/inferred heuristic decision must be traceable. No-op default exporter (zero overhead in production). |
| `@veoable/graph-db` | SQLite-backed canonical `GraphStore`. `commit` (transactional, validates via schema, idempotent on content-addressed IDs), `getNode`, `findNodes` (with property filters including boolean coercion), `findEdges`. Content-addressed edge IDs via SHA-1 of canonical JSON. |
| `@veoable/core` | Shared utility (currently `createLogger` / `Logger`). |

#### Node Types

`SourceFile`, `FunctionDefinition`, `APIEndpoint`, `ClientSideAPICaller`, `ClientSideProcess`, `DatabaseSystem`, `DatabaseTable`, `DatabaseColumn`, `DatabaseInteraction`

#### Edge Types

`IMPORTS`, `EXPORTS`, `DEFINED_IN`, `CALLS_FUNCTION`, `RESOLVES_TO_ENDPOINT`, `TABLE_IN`, `COLUMN_IN`, `FOREIGN_KEY`, `READS`, `WRITES`, `PERFORMED_BY`

### Language Plugin

| Package | Purpose |
|---------|---------|
| `@veoable/lang-ts` | TypeScript/JavaScript language plugin built on ts-morph 27. Structural extraction (`SourceFile`, `FunctionDefinition`, `IMPORTS`, `EXPORTS`, `DEFINED_IN`). Call graph (`CALLS_FUNCTION` with 4-level confidence: direct/method/indirect/dynamic). Cross-file resolution. Recursive walker covering nested functions, class methods, getters/setters/constructors, class expressions. `TsFrameworkVisitor` interface with single `onNode(ctx, node)` callback dispatched during the AST walk. Performance canary asserting less than 3x overhead. |

### Framework Plugins

| Package | Purpose |
|---------|---------|
| `@veoable/framework-prisma` | Prisma schema parsing (`DatabaseSystem`/`Table`/`Column`/`FOREIGN_KEY` from `schema.prisma`) and Prisma Client call-site detection (`DatabaseInteraction` + `READS`/`WRITES`/`PERFORMED_BY` for `prisma.X.crudMethod()` patterns including `$queryRaw` tagged templates). Name-based receiver heuristic with inferred confidence. |
| `@veoable/framework-react` | React client-side process detection. JSX event handlers (`onClick`, `onSubmit`, etc. via `/^on[A-Z]/` rule) and lifecycle hooks (`useEffect`, `useLayoutEffect`, `useInsertionEffect`). Emits `ClientSideProcess` nodes. |
| `@veoable/framework-express` | Express server-side endpoint detection. `app.get('/path', handler)` and `router.METHOD` patterns. Same-file handler resolution to `FunctionDefinition` IDs. |
| `@veoable/framework-fetch` | Client-side API caller detection for the built-in `fetch()` API. URL + method extraction with 3-level egress confidence (exact/pattern/dynamic). Template literal prefix extraction for pattern matching. |

### Flow Stitcher

| Package | Purpose |
|---------|---------|
| `@veoable/flow-stitcher` | Two layers: (1) URL matcher + `RESOLVES_TO_ENDPOINT` edge emission, matching `ClientSideAPICaller` URLs against `APIEndpoint` route patterns with confidence levels (high/medium/low) and `matchedBy` types (exact-url/pattern/inferred). Internal `matchRank` tier for tiebreak. (2) Flow walker / query API via `createFlowWalker(store).walkAllProcesses()`, returning structured `Flow` objects tracing the full path from process to database. Gap handling via `FlowCompleteness`. BFS with cycle breaking and bounded depth (default 10). |

#### Flow Completeness Levels

| Level | Description |
|-------|-------------|
| `complete` | Full path from process through API caller to endpoint to database interaction |
| `process-only` | Process detected but no outgoing API call found |
| `function-only` | Function calls detected but no API caller |
| `caller-only` | API caller found but could not resolve to an endpoint |
| `endpoint-only` | Endpoint matched but no handler function resolved |
| `handler-only` | Handler resolved but no database interaction found |

### User-Facing Packages

| Package | Purpose |
|---------|---------|
| `@veoable/cli` | CLI entry point. `veoable analyze <path>` runs the full pipeline and prints human-readable flows. `veoable serve <graph.db>` starts the MCP server. Options: `--output`, `--format text\|json`, `--verbose`, `--max-call-depth`, `--exclude`. |
| `@veoable/mcp-server` | MCP server exposing 8 tools for AI agent integration. Pure data server, no AI API key needed. |

### Placeholder Packages

| Package | Purpose |
|---------|---------|
| `@veoable/agents` | Placeholder for future detection engines. |
| `@veoable/ui` | Placeholder for future graphical interface. |

---

## Project Statistics

- **730 tests** across 26 test files, all passing
- **Zero stderr warnings** during test runs
- Full **ESM + TypeScript strict mode + ESLint + Prettier**
- **OTEL observability** with confidence decision span events
- **16 packages** in a pnpm monorepo

---

## Getting Started

### Prerequisites

- **Node.js 22+**
- **pnpm 10+**

### Installation

```bash
git clone https://github.com/mudit70/veoable.git
cd veoable
pnpm install
pnpm build
```

---

## CLI Usage

### Analyze a project

```bash
# Basic analysis
node packages/cli/dist/cli.js analyze /path/to/your/project

# With verbose output and graph persistence
node packages/cli/dist/cli.js analyze /path/to/your/project --output graph.db --verbose

# JSON output for programmatic consumption
node packages/cli/dist/cli.js analyze /path/to/your/project --format json > flows.json
```

### What the CLI does

1. Scans for `.ts` / `.tsx` / `.js` / `.jsx` source files.
2. Auto-detects frameworks (React, Express, Prisma, fetch).
3. Parses Prisma schemas if present.
4. Extracts every source file (structural + call graph + framework-specific nodes).
5. Stitches client-side callers to server-side endpoints via URL matching.
6. Walks all end-to-end flows.
7. Prints the results.

### CLI Options

| Option | Description |
|--------|-------------|
| `--output <path>` | Save the graph database to a file for later use with the MCP server |
| `--format text\|json` | Output format (default: `text`) |
| `--verbose` | Enable detailed logging during analysis |
| `--max-call-depth <n>` | Maximum BFS depth for call graph traversal (default: 10) |
| `--stitch-mode <mode>` | Stitching mode: `none`, `auto-exact` (default), `auto-all` |
| `--repo-name <name>` | Override the repository name (default: directory name) |
| `--clean` | Delete existing nodes for this repo before re-analyzing (for multi-repo) |
| `--exclude <glob>` | Glob pattern(s) to exclude from analysis |

### Stitching modes

Stitching connects client-side API calls (e.g., `fetch('/api/users')`) to server-side endpoints (e.g., `app.get('/api/users', handler)`). The `--stitch-mode` flag controls how aggressively this matching is done.

| Mode | What it does | When to use |
|------|-------------|-------------|
| **`auto-exact`** (default) | Only stitches deterministic matches — exact URL strings and segment-count matches. A template like `` fetch(`/api/users/${id}`) `` with 1 interpolation matches `/api/users/:id` (3 segments) but rejects `/api/users/:userId/posts` (4 segments). | Normal use. Produces clean flows with no false positives. |
| **`auto-all`** | Stitches everything including heuristic/ambiguous matches. A template URL prefix like `/api/users/` may match multiple endpoints, producing duplicate flows. | Quick exploration when you want to see all possible connections, even uncertain ones. |
| **`none`** | Builds the client and server graphs but does no stitching. Callers and endpoints are detected but not connected. | When you want full control — use the MCP/REST tools to stitch interactively. |

#### Interactive stitching workflow

For maximum accuracy, use `none` mode and stitch interactively:

```bash
# 1. Analyze without stitching
veoable analyze ./project --output graph.db --stitch-mode none

# 2. Start the server
veoable serve graph.db
```

Then via MCP (Claude Code, Cursor) or REST API:

```
# See what the stitcher would propose
> suggest_stitches

# Auto-accept only deterministic matches
> auto_stitch --minConfidence deterministic

# Manually confirm an ambiguous match
> confirm_stitch --callerId "ClientSideAPICaller:..." --endpointId "APIEndpoint:..." --reason "PostList fetches posts"

# Reject a wrong suggestion
> reject_stitch --callerId "..." --endpointId "..." --reason "This targets users, not posts"
```

The stitching tools group proposals into tiers:
- **deterministic** — exact URL match or segment-count match (safe to auto-accept)
- **heuristic** — single candidate via pattern prefix (usually correct, worth reviewing)
- **ambiguous** — multiple candidates at same confidence (needs human/AI judgment)

Each confirmed stitch stores an audit trail: who confirmed it (`human`, `ai`, or `auto`), when, which strategy produced it, and an optional reason.

### Multi-repo projects

Analyze multiple repositories into the same database:

```bash
veoable analyze ./frontend     --output project.db --repo-name frontend
veoable analyze ./user-service --output project.db --repo-name user-api --clean
veoable analyze ./post-service --output project.db --repo-name post-api --clean
veoable serve project.db
```

Each repo's nodes carry a distinct `repository` name. The `--clean` flag deletes old nodes for that repo before re-inserting, so re-analysis is safe. Content-addressed IDs prevent collisions across repos.

### Example output

```
Veoable analysis: /path/to/project
--------------------------------------------------------------------
Source files:  7
Frameworks:    prisma, react, express, fetch
DB schema:     1 system(s), 1 table(s), 4 column(s)
Stitching:     2 resolved, 0 dynamic (deferred)
Flows:         4 complete, 0 partial

End-to-end flows:

  1. lifecycle_hook "useEffect" (...)
     -> fetch GET /api/users [exact]
     -> GET /api/users [high, exact-url]
     -> listUsersHandler()
     -> prisma -> User [read]

  2. event_handler "onClick" (...)
     -> fetch GET /api/users/ [pattern]
     -> GET /api/users/:id [medium, pattern]
     -> getUserHandler()
     -> prisma -> User [read]
```

---

## Serving the Knowledge Graph

Veoable exposes the knowledge graph via four serve modes. All modes use the same tool implementations — the difference is the transport.

### Four serve modes

```bash
# 1. stdio MCP — for Claude Code, Cursor, Windsurf, Continue.dev
veoable serve graph.db

# 2. HTTP MCP — for MCP clients that connect over the network
veoable serve graph.db --transport http --port 3001

# 3. REST API — for Ollama, OpenAI Codex, Lovable, LangChain, web UIs, curl
veoable serve graph.db --rest --port 3001

# 4. Built-in chat — interactive chat with a local LLM
veoable chat graph.db --model llama3
```

| Mode | Flag | For |
|------|------|-----|
| stdio MCP | (default) | Claude Code, Cursor, Windsurf, Continue.dev |
| HTTP MCP | `--transport http` | MCP clients over network |
| REST API | `--rest` | Ollama, Codex, Lovable, LangChain, web UI, curl |
| Built-in chat | `chat` command | Interactive use with any local/remote LLM |

### Mode 1: stdio MCP (Claude Code, Cursor)

The default mode. The AI client spawns the server as a child process and communicates via stdin/stdout using the MCP protocol.

The repo includes a `.mcp.json` at the project root with the Veoable MCP server pre-configured. Claude Code and Cursor will pick it up automatically — no manual setup needed.

To configure manually in another project:

```json
{
  "mcpServers": {
    "veoable": {
      "command": "node",
      "args": ["packages/cli/dist/cli.js", "serve", "graph.db"]
    }
  }
}
```

**Note:** You must generate `graph.db` first by running the analyze command with `--output graph.db`.

### Mode 2: HTTP MCP (network MCP clients)

For MCP clients that connect over HTTP instead of spawning a child process:

```bash
veoable serve graph.db --transport http --port 3001
```

The MCP protocol is exposed at `POST http://localhost:3001/mcp`. Configure your MCP client to point at this URL.

### Mode 3: REST API (Ollama, Codex, Lovable, curl)

For LLMs and tools that don't speak MCP:

```bash
veoable serve graph.db --rest --port 3001
```

Endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tools` | List all tools with OpenAI function-calling schemas |
| POST | `/api/tools/:name` | Execute a tool with JSON body |
| GET | `/health` | Health check |

Example usage with curl:

```bash
# List all API endpoints
curl -X POST http://localhost:3001/api/tools/list_nodes \
  -H 'Content-Type: application/json' \
  -d '{"nodeType": "APIEndpoint"}'

# Walk all end-to-end flows
curl -X POST http://localhost:3001/api/tools/walk_all_flows \
  -H 'Content-Type: application/json' \
  -d '{}'

# Get tool schemas for LLM integration
curl http://localhost:3001/api/tools
```

The `GET /api/tools` response is in OpenAI function-calling format, so any LLM that supports tool use can consume the schemas directly.

### Mode 4: Built-in chat (Ollama, LM Studio, OpenAI-compatible LLMs)

For interactive use without setting up a separate client:

```bash
# With Ollama (default, localhost:11434)
veoable chat graph.db --model llama3

# With LM Studio (localhost:1234)
veoable chat graph.db --llm http://localhost:1234/v1 --model qwen/qwen2.5-coder-14b

# With a remote OpenAI-compatible API
veoable chat graph.db --llm https://api.openai.com/v1 --model gpt-4
```

The chat orchestrator:
1. Loads the graph and tool definitions internally (no separate server process)
2. Connects to the LLM's chat API
3. Sends tool schemas as function definitions
4. Runs an interactive loop: you ask → LLM calls tools → results sent back → LLM answers

```
you> What API endpoints exist?
assistant> The project has 8 API endpoints:
  - GET /api/users (listUsersHandler → reads User)
  - POST /api/users (createUserHandler → writes User)
  ...

you> What happens when the user deletes a user?
assistant> The delete user flow traces from UserDetail.tsx...
```

Type `exit` to quit.

### Using with LM Studio

LM Studio supports both MCP and OpenAI-compatible tool calling. Three ways to integrate:

**Option A: MCP config in LM Studio**

In LM Studio's MCP settings, add the Veoable server. Use absolute paths:

```json
{
  "mcpServers": {
    "veoable": {
      "command": "node",
      "args": [
        "/Users/you/projects/veoable/packages/cli/dist/cli.js",
        "serve",
        "/Users/you/projects/veoable/graph.db"
      ]
    }
  }
}
```

LM Studio will spawn the MCP server and make the tools available to the loaded model. The model must support tool calling (e.g., Qwen 2.5 Coder, Llama 3.x).

**Option B: Built-in chat command (recommended)**

The simplest approach — no LM Studio MCP config needed:

```bash
veoable chat graph.db --llm http://localhost:1234/v1 --model qwen/qwen2.5-coder-14b
```

This connects directly to LM Studio's OpenAI-compatible API and handles the tool-calling loop. The tools execute locally against graph.db — LM Studio just provides the LLM.

**Option C: REST API for custom integration**

Start the REST server and use LM Studio's chat with manual tool calls:

```bash
veoable serve graph.db --rest --port 3001
```

**Tested models with LM Studio:**

| Model | Tool calling | Notes |
|-------|-------------|-------|
| `qwen/qwen2.5-coder-14b` | Works | Good balance of capability and speed |
| `qwen/qwen2.5-coder-32b` | Works | Better results but needs ~20GB RAM |
| `llama-3.2-8b-instruct` | Varies | May not reliably call tools |
| `deepseek-r1-*` | Varies | Reasoning models may not use tools |

**Tip:** Models need to support function/tool calling for the chat orchestrator to work. Qwen 2.5 Coder models are reliable for this.

### How it works with Claude

When Claude Code starts, it reads `.mcp.json`, connects to the Veoable MCP server, and receives the list of available tools. These tool names and descriptions become part of Claude's context — just like its built-in tools (Read, Edit, Bash, etc.).

When you ask a question, Claude matches it against all available tools. If your question is about flows, endpoints, or the knowledge graph, Claude recognizes that the Veoable MCP tools are the right fit and calls them automatically. There is no special syntax — you just ask naturally.

If the MCP server is not running or `graph.db` does not exist, Claude will not have access to the Veoable tools and cannot answer these questions.

### Example questions you can ask

Once the MCP server is running with a populated `graph.db`, you can ask Claude questions like:

**Exploring flows**
- "What end-to-end flows exist in this project?"
- "What happens when the user submits the create user form?"
- "Show me all flows that touch the Post table"
- "Which flows involve a DELETE operation?"
- "Trace the flow from the UserList component to the database"

**Inspecting endpoints and callers**
- "List all API endpoints in the project"
- "Which API callers couldn't be resolved to endpoints?"
- "Show me all Express routes"
- "What fetch calls are made from the React components?"

**Database interactions**
- "What database tables exist in the schema?"
- "Show me all database interactions on the User table"
- "Which functions write to the Post table?"
- "What columns does the Comment table have?"

**Debugging gaps**
- "Which flows have gaps or are incomplete?"
- "Are there any API callers with dynamic URLs that couldn't be matched?"
- "Which event handlers don't reach the database?"
- "Re-run URL matching between callers and endpoints"

**Understanding structure**
- "What functions does server.ts export?"
- "What does the getUserHandler function call?"
- "Show me the call chain from listUsersHandler to the database"
- "What edges connect to this node?"

### Available Tools

All tools are available in all four serve modes (MCP, HTTP MCP, REST API, and chat).

| Tool | Description | Example prompt |
|------|-------------|----------------|
| `list_nodes` | List all nodes of a given type | "Show me all API endpoints" |
| `get_node` | Retrieve details of a specific node by ID | "Get details of this specific function" |
| `find_edges` | Find edges connected to a node | "What calls this function?" |
| `walk_flows` | Walk flows starting from a specific process | "What happens when the user clicks this button?" |
| `walk_all_flows` | Walk all end-to-end flows in the graph | "Show me all end-to-end flows" |
| `stitch` | Re-run URL matching between callers and endpoints | "Re-run URL matching" |
| `suggest_stitches` | Propose matches between client callers and server endpoints | "What stitching suggestions are there?" |
| `confirm_stitch` | Confirm a match between a caller and an endpoint | "Confirm this caller targets this endpoint" |
| `reject_stitch` | Record rejection of a proposed match | "This match is wrong" |
| `auto_stitch` | Auto-accept matches above a confidence level | "Auto-stitch all deterministic matches" |
| `list_server_endpoints` | List endpoints with handler and DB effects | "What endpoints exist and what do they do?" |
| `list_client_api_calls` | List client-side API calls with trigger context | "What fetch calls exist and what triggers them?" |
| `list_unmatched_callers` | List API callers that could not be resolved | "Which API calls couldn't be resolved?" |
| `list_incomplete_flows` | List flows with gaps in the chain | "Which flows have gaps?" |
| `get_source_file` | Read source code for a graph node | "Show me the code for this function" |

---

## Programmatic API

```typescript
import { analyze, formatText } from '@veoable/cli';

const result = await analyze({
  rootDir: '/path/to/project',
  dbPath: 'graph.db', // optional, defaults to :memory:
  verbose: true,
  onProgress: (msg) => console.log(msg),
});

console.log(formatText(result));

// Or access the raw data
for (const flow of result.flows) {
  if (flow.completeness === 'complete') {
    console.log(
      `${flow.startProcess.name} -> ${flow.endpoint?.routePattern} -> ${flow.databaseHops[0]?.readsTable?.name}`
    );
  }
}

result.store.close();
```

---

## Running Tests

```bash
pnpm test              # Run all 733 tests
pnpm test:integration  # Run integration tests only
pnpm lint              # Run ESLint
pnpm build             # Build all packages
```

---

## Supported Stack

As of April 9, 2026, Veoable supports the following technologies:

| Layer | Technology | Detection Capability |
|-------|-----------|---------------------|
| **Language** | TypeScript / JavaScript | Full structural extraction, call graph, cross-file resolution |
| **Frontend** | React | JSX event handlers (`onClick`, `onSubmit`, etc.) and lifecycle hooks (`useEffect`, `useLayoutEffect`, `useInsertionEffect`) |
| **HTTP Client** | `fetch` (built-in) | URL + method extraction, template literal prefix extraction, 3-level egress confidence |
| **Backend** | Express | Route declarations (`app.get`, `router.METHOD`), same-file and cross-file handler resolution |
| **ORM** | Prisma | Schema parsing (systems, tables, columns, foreign keys) + CRUD call-site detection including `$queryRaw` |
| **Database** | PostgreSQL, MySQL, SQLite, MongoDB | Via Prisma schema detection |

---

## Issues Closed

The following issues have been resolved as of this update:

#4, #8 (partial), #15, #36, #39, #47, #56, #65, #67, #78, #83, #84, #85, #86, #87, #88, #91, #92, #96, #98, #99, #100, #101, #102, #103, #104

---

## Known Limitations and Open Issues

### Resolved in Architecture v2

| Issue | Description | Resolution |
|-------|-------------|------------|
| #83 | Named JSX handler references unreachable | React visitor now resolves named refs via TRIGGERS edges |
| #86 | TsVisitContext missing rootDir | rootDir + repository added, Express visitor uses them for cross-file resolution |
| #87 | FlowDatabaseHop single table only | Widened to readsTables/writesTables arrays |
| #88 | Flow walker O(all-nodes) scans | Replaced with filtered findNodes queries |

### Still Open

| Issue | Description |
|-------|-------------|
| #89 | `FunctionDefinition` ID naming logic is duplicated between `lang-ts` and `framework-express`. |
| #97 | Accuracy catalogue: 7 of 12 inaccuracy sources remain open (P2/P3 edge cases). |
| -- | Route composition from `app.use('/prefix', router)` is not handled (routes are emitted as declared). |
| -- | Object literal methods are not walked as `FunctionDefinition` nodes. |
| -- | `reject_stitch` records rejection but does not delete the edge (edge deletion not yet implemented). |

---

## Future Framework Support

The following framework plugins are planned or tracked as open issues:

### Frontend Frameworks

| Framework | Issue |
|-----------|-------|
| Vue.js | #57 |
| Angular | #58 |
| Svelte | #59 |
| Next.js | #60 |

### State Management

| Library | Issue |
|---------|-------|
| Redux, Zustand, MobX | #61 |

### HTTP Clients

| Library | Issue |
|---------|-------|
| axios, React Query, Apollo Client, tRPC | #2 |

### Backend Frameworks -- Node.js

| Framework | Issue |
|-----------|-------|
| NestJS | #16 |
| Fastify | #17 |
| Koa | #27 |
| Hapi | #27 |

### Backend Frameworks -- Python

| Framework | Issue |
|-----------|-------|
| FastAPI | #19 |
| Flask | #20 |
| Django | #21 |

### Backend Frameworks -- Go

| Framework | Issue |
|-----------|-------|
| Gin | #22 |
| Echo / Fiber | #23 |

### Backend Frameworks -- Rust

| Framework | Issue |
|-----------|-------|
| Actix-web | #24 |
| Axum | #25 |
| Rocket | #26 |

### Backend Frameworks -- Java

| Framework | Issue |
|-----------|-------|
| Spring Boot | #28 |

### ORM / Database Libraries

| Library | Issue |
|---------|-------|
| Mongoose | #48 |
| SQLAlchemy | #49 |
| Django ORM | #50 |
| JPA / Hibernate | #51 |
| GORM | #52 |
| TypeORM / Sequelize | #53 |
| Supabase JS | #54 |
| Eloquent | #55 |
