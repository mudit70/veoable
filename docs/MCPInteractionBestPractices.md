# MCP Interaction Best Practices

This guide shows how to effectively use Adorable's MCP tools — either through the interactive chat CLI or through an AI assistant (Claude Code, Cursor, Windsurf) connected via MCP.

---

## Table of Contents

1. [Setup Workflow](#setup-workflow)
2. [Interactive Stitching](#interactive-stitching)
3. [Querying the Graph](#querying-the-graph)
4. [Debugging Flows](#debugging-flows)
5. [Impact Analysis](#impact-analysis)
6. [Common Conversation Patterns](#common-conversation-patterns)

---

## Setup Workflow

### Step 1: Initialize and analyze

```bash
# Generate project config (for monorepos)
node packages/cli/dist/cli.js project init /path/to/project

# Review and edit the generated config file:
# - Remove packages that don't need analysis (test fixtures, build tools)
# - Adjust repo names for clarity

# Analyze the project
node packages/cli/dist/cli.js project analyze myproject.project.json --verbose --fresh
```

For single-repo projects:

```bash
node packages/cli/dist/cli.js analyze /path/to/project --output graph.db --verbose --fresh
```

### Step 2: Start the chat

```bash
node packages/cli/dist/cli.js chat myproject.db \
  --project-root /path/to/project \
  --project-config myproject.project.json \
  --llm https://openrouter.ai/api/v1 \
  --model anthropic/claude-sonnet-4
```

Flags explained:
- `--project-root` — where source files live (for `get_source_file` tool)
- `--project-config` — enables stitch rule tools (add/apply/review rules)
- `--llm` — LLM API endpoint (OpenRouter, OpenAI, or local Ollama)
- `--model` — model name (e.g., `anthropic/claude-sonnet-4`, `llama3`)

For local Ollama (no API key needed):

```bash
node packages/cli/dist/cli.js chat graph.db \
  --project-root /path/to/project \
  --model llama3
```

---

## Interactive Stitching

Stitching connects frontend API callers (`fetch("/api/users")`) to backend endpoints (`GET /users`). When URLs don't match exactly (e.g., prefix mismatch), you need stitch rules.

### Example conversation

```
you> show me the stitch report

assistant> [calls stitch_report]
  Stitched: 83 endpoints successfully connected
  Unresolved: 20 endpoints with connection issues
  Dynamic: 5 callers with dynamically computed URLs
  External: 4 callers to external services

  Common pattern: 20 callers have /api prefix not matching endpoints...

you> review the unresolved callers and suggest fixes

assistant> [calls ai_stitch_review]
  Proposal: stripPrefix "/api" from web → api
  Reasoning: 20 callers have /api prefix that doesn't match server routes
  Affected callers: 20

you> apply that rule

assistant> [calls add_stitch_rule with name="Strip /api prefix", from="web", to="api",
           transformType="stripPrefix", prefix="/api"]
  Rule saved to myproject.project.json

you> now apply the stitch rules

assistant> [calls apply_stitch_rules]
  17 new stitches applied
  Rules applied: ["Strip /api prefix"]

you> show me the stitch report again

assistant> [calls stitch_report]
  Stitched: 100 (was 83)
  Unresolved: 3 (was 20)
  Dynamic: 5 (unchanged)
```

### Non-interactive alternative

Add the rule directly to your project config and re-analyze:

```json
{
  "stitchRules": [
    {
      "name": "Strip /api prefix",
      "from": "web",
      "to": "api",
      "transform": { "stripPrefix": "/api" }
    }
  ]
}
```

```bash
node packages/cli/dist/cli.js project analyze myproject.project.json --verbose --fresh
```

---

## Querying the Graph

### Getting an overview

```
you> give me an overview of the project architecture

assistant> [calls describe_architecture]
  Endpoint domains: /api/users (8 endpoints), /api/auth (5 endpoints)
  Databases: PostgreSQL via Prisma (16 tables)
  Frontend: 130 source files, 95 API calls, 820 UI processes

you> how many API endpoints are there?

assistant> [calls stats]
  218 API endpoints, 117 client API callers, 920 client-side processes
```

### Listing specific nodes

```
you> show me all API endpoints

assistant> [calls list_server_endpoints]
  GET /api/users — listUsersHandler (reads: User)
  POST /api/users — createUserHandler (writes: User)
  GET /api/users/:id — getUserHandler (reads: User)
  ...

you> show me all fetch calls from the frontend

assistant> [calls list_client_api_calls]
  UserList.tsx: useEffect → GET /api/users (exact)
  CreateUser.tsx: onSubmit → POST /api/users (exact)
  ...

you> which callers have no matching endpoint?

assistant> [calls list_unmatched_callers]
  GET /api/settings — no endpoint found
  POST /api/export — no endpoint found
```

---

## Debugging Flows

### Walking end-to-end flows

```
you> show me all complete end-to-end flows

assistant> [calls walk_all_flows with completenessFilter="complete"]
  Flow 1: onClick (CreateUser.tsx:25) → POST /api/users → createUserHandler
          → prisma.user.create → User [write]
  Flow 2: useEffect (UserList.tsx:12) → GET /api/users → listUsersHandler
          → prisma.user.findMany → User [read]
  ...

you> show me flows that touch the User table

assistant> [calls walk_all_flows with filterByTable="User"]
  5 flows touching User table...

you> show me incomplete flows

assistant> [calls list_incomplete_flows]
  3 flows stopped before reaching the database:
  - onClick handler in Settings.tsx has no API call
  - GET /api/config endpoint has no database interaction
```

### Reading source code

```
you> show me the source code for the createUserHandler

assistant> [calls get_source_file with nodeId="FunctionDefinition:abc123"]
  src/handlers/users.ts (lines 25-45):
  export async function createUserHandler(req, res) {
    const { name, email } = req.body;
    const user = await prisma.user.create({ data: { name, email } });
    res.status(201).json(user);
  }
```

---

## Impact Analysis

### What breaks if I change this?

```
you> what's the blast radius if I change the User table?

assistant> [calls impact_analysis with tableName="User"]
  5 endpoints affected:
  - POST /api/users (writes User)
  - GET /api/users (reads User)
  - GET /api/users/:id (reads User)
  - PUT /api/users/:id (writes User)
  - DELETE /api/users/:id (writes User)
  
  8 frontend callers depend on these endpoints
  3 React components would be affected

you> what flows are affected by changes to src/handlers/users.ts?

assistant> [calls diff_flows with changedFiles=["src/handlers/users.ts"]]
  4 flows affected:
  - CreateUser form → POST /api/users → User [write]
  - UserList useEffect → GET /api/users → User [read]
  - ...
```

---

## Common Conversation Patterns

### Architecture discovery
- "Give me an overview of the project"
- "What frameworks does this project use?"
- "How many endpoints/tables/components are there?"

### Flow tracing
- "Trace the flow from the login button to the database"
- "Show me all flows that write to the User table"
- "Which endpoints have no frontend callers?"

### Stitching
- "Show the stitch report"
- "Why isn't GET /api/users stitched?"
- "Suggest stitch rules for the unresolved callers"
- "Apply the suggested strip /api rule"

### Impact analysis
- "What breaks if I change the User model?"
- "Which flows are affected by changes to auth.ts?"
- "Show me all endpoints that share the Orders table"

### Code exploration
- "Show me the source code for the createUser handler"
- "What does the useEffect in UserList.tsx do?"
- "Show me the Prisma schema for the User table"

---

## Tips

- **Start with `stats` or `describe_architecture`** to orient yourself before diving into specifics.
- **Use `walk_all_flows` with filters** (`filterByTable`, `filterByEndpoint`, `filterByFile`) to narrow down to relevant flows.
- **Check `list_unmatched_callers`** after analysis to find stitching gaps.
- **Always review stitch rule suggestions** before applying — the system suggests but never auto-applies.
- **Re-analyze after code changes** to keep the graph up to date. The `--fresh` flag ensures a clean start.
- **Use `--project-config`** in chat/serve mode if you need interactive stitch rule management.
