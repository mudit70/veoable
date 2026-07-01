# Quickstart

From zero to asking Claude about your codebase in five minutes.

## 1. Install (one-time)

```sh
pnpm add -g @veoable/cli   # or however you install veoable
```

Verify with `veoable --help`.

## 2. Build a graph

In your project root:

```sh
veoable project init .                              # generates <name>.project.json
veoable project analyze <name>.project.json --fresh # writes <name>.db
```

For a single repo (no monorepo):
```sh
veoable analyze . --output graph.db --fresh
```

That's the analysis. You only re-run it when the code changes.

## 3. Register the MCP server with Claude Code

Project-scoped (auto-loads when you `cd` into this project):

```sh
claude mcp add --scope project veoable -- veoable serve $(pwd)/<name>.db --project-config $(pwd)/<name>.project.json
```

The `--` separator before `veoable serve` is required so Claude doesn't intercept `--project-config`.

Verify:
```sh
claude mcp list
```
Should show `veoable: ... - ✓ Connected`.

## 4. Ask Claude

Start a Claude Code session in the project directory. Tools become available automatically. Try:

> Use the veoable MCP server to give me a high-level architecture overview.

> What happens when a user taps Login on the mobile app?

> Are there any API endpoints with no frontend caller?

> Which database tables get written by the `/api/users/:id` endpoint, and what other endpoints touch the same tables?

> What's the impact if I change `src/auth/auth.controller.ts`?

## 5. Re-analyze after code changes

```sh
veoable project analyze <name>.project.json --fresh
```

The MCP server reads the DB lazily — Claude picks up the new graph on the next question. No restart needed.

---

## Going deeper

- **Comprehensive question + action catalog**: see [`mcp-usage.md`](./mcp-usage.md).
- **Multi-app monorepos** (e.g., RN client + admin web with separate backends): add an `applications` block to your project config so the stitcher doesn't cross-link them. Example in [`mcp-usage.md`](./mcp-usage.md#1-build-a-graph).
- **Stitching workflow** (URL prefix mismatches, ambiguous matches, etc.): the `suggest_stitches` / `add_stitch_rule` tools — see the *Actions* section of [`mcp-usage.md`](./mcp-usage.md#actions-an-llm-can-take).

## Troubleshooting

- **"Heap out of memory" on analyze**: your repo is big enough to exceed V8's heap. Use `project init` + `project analyze` to decompose into per-package analyses sharing one DB. (Tracked in #253.)
- **`claude mcp list` shows "✗ Failed to connect"**: check the path to your `.db` file is absolute, and that you've run `veoable project analyze` at least once to create it.
- **An LLM answer references a screen / endpoint / handler that should exist but the tool returns null**: see the "Limitations" section of [`mcp-usage.md`](./mcp-usage.md#limitations-the-llm-should-know-about). Most often it's a class-component HOC wrap (#289) or a dynamic URL — fall back to reading the source file directly.
