# Veoable — Installing the LLM-Client Skill

`adorable install <client>` writes the canonical Veoable skill into your LLM
client's expected location so the agent knows when to invoke Veoable's MCP
tools without you having to explain it. This guide covers the four supported
clients and the `--auto` shortcut.

If you're new to Veoable, start with the [User Guide](userguide.md) — get
`adorable project analyze` producing a graph DB first, then come back here.

---

## Table of contents

1. [Mental model](#mental-model)
2. [Prerequisites](#prerequisites)
3. [Quick start: `adorable install --auto`](#quick-start-adorable-install---auto)
4. [Per-client install](#per-client-install)
   - [Claude Code](#claude-code)
   - [Cursor](#cursor)
   - [Continue.dev](#continuedev)
   - [VS Code + Copilot Chat](#vs-code--copilot-chat)
5. [The `--db` flag](#the---db-flag)
6. [Verifying the install](#verifying-the-install)
7. [Updating the skill](#updating-the-skill)
8. [Removing the skill](#removing-the-skill)
9. [What `adorable install` doesn't do](#what-adorable-install-doesnt-do)
10. [Troubleshooting](#troubleshooting)

---

## Mental model

Veoable ships in two pieces for any LLM client:

1. **A skill description** — a piece of markdown the agent reads to know
   *when* Veoable applies. It lists the question shapes that should
   trigger Veoable tools ("what does this app do?", "what breaks if I
   change this endpoint?") and the question shapes that shouldn't
   (syntax errors, build/CI issues, runtime traces).
2. **An MCP server entry** — the wiring that lets the agent actually
   *call* Veoable. The server is `adorable serve <graph.db>` — same
   binary you already have installed, pointed at the graph you built
   with `adorable project analyze`.

`adorable install <client>` writes both into your LLM client's expected
locations. Each client's install path is slightly different (some are
user-scoped, some project-scoped; some use one file, some use two) and
this guide explains each. The canonical content is shared: the same
SKILL.md from [`packages/skill/SKILL.md`](../packages/skill/SKILL.md)
ships into every adapter.

---

## Prerequisites

Before installing into any client:

```bash
# 1. Install Veoable itself.
git clone https://github.com/mudit70/adorable
cd adorable
git checkout v0.3.0
pnpm install
pnpm install-cli

# 2. Build a graph for your project.
cd ~/my-project
adorable project init .
adorable project analyze my-project.project.json

# 3. Verify the graph works.
adorable serve my-project.db --transport http --port 3001
# In another terminal:
curl http://localhost:3001/api/tools | jq '.tools[] | .function.name' | head
# (Ctrl-C the serve command once you've confirmed it lists tools.)
```

You now have `my-project.db` on disk. The client installs below will
point Veoable's MCP server at it.

---

## Quick start: `adorable install --auto`

If you don't know (or don't care) which LLM clients are installed on your
machine, run:

```bash
cd ~/my-project
adorable install --auto --db my-project.db
```

It detects each supported client and installs into every one it finds:

```
✓ Installed skill 'claude-code'.
  Wrote: /Users/me/.claude/skills/adorable/SKILL.md
✓ Installed skill 'cursor'.
  Wrote: /Users/me/my-project/.cursor/rules/adorable.mdc
         /Users/me/my-project/.cursor/mcp.json
Skipped (no detection signal):
  · continue: ~/.continue not found (Continue doesn't appear to be installed; run `adorable install continue` to set up anyway)
  · vscode:   neither .vscode/ nor .github/copilot-instructions.md found (...)
Next steps:
  [claude-code]
    Build a graph for your project (if you haven't already): ...
    Register the MCP server with Claude Code so the skill has data to query:
      claude mcp add adorable -- adorable serve <project.db>
  [cursor]
    Restart Cursor (or reload the window) ...
```

**Detection signals:**

| Client      | Detected when                                                            |
| ----------- | ------------------------------------------------------------------------ |
| claude-code | `$CLAUDE_CONFIG_DIR` exists OR `~/.claude/` exists                       |
| cursor      | `<cwd>/.cursor/` exists                                                  |
| continue    | `$CONTINUE_GLOBAL_DIR` exists OR `~/.continue/` exists                   |
| vscode      | `<cwd>/.vscode/` OR `<cwd>/.github/copilot-instructions.md` exists       |

Clients without a detection signal are listed as "skipped" with a hint
about how to install explicitly. Run `--auto` from your project root so
the project-scoped clients (cursor, vscode) see their config dirs.

`--auto` is **best-effort**: if one adapter throws (e.g., your
`~/.claude/skills/` is a regular file instead of a directory), it's
reported under `Failed:` and the other adapters continue. Exit code is
non-zero if anything failed, so CI can react.

---

## Per-client install

### Claude Code

```bash
adorable install claude-code
```

- **Scope:** user-scoped.
- **Writes:** `SKILL.md` to `$CLAUDE_CONFIG_DIR/skills/adorable/` (or
  `~/.claude/skills/adorable/` by default).
- **Idempotent:** re-running overwrites with the current canonical
  content.
- **MCP server:** *not* registered automatically. Claude Code stores MCP
  server entries in `~/.claude.json` which `adorable install` won't
  touch — you don't want a corrupted config from a tool you didn't
  schedule. Wire the server yourself once your graph DB exists:

  ```bash
  cd ~/my-project
  adorable project analyze my-project.project.json
  claude mcp add adorable -- adorable serve "$PWD/my-project.db"
  ```

Restart Claude Code (fully quit, not just close the window) so it
picks up the skill and the new MCP server.

Use the skill: in any Claude Code session, ask a question that matches
the skill's triggers — "what does this app do?", "what's the login
flow?", "what breaks if I rename `users.email`?" — and Claude will route
to Veoable's tools automatically.

### Cursor

```bash
cd ~/my-project
adorable install cursor --db my-project.db
```

- **Scope:** project-scoped — run from the project root.
- **Writes:**
  - `.cursor/rules/adorable.mdc` — always. A Cursor "Agent Requested"
    rule (`alwaysApply: false`) that activates by description matching.
  - `.cursor/mcp.json` — only when `--db` is provided. Merges the
    `adorable` entry with whatever you already have under
    `mcpServers` (other server entries are preserved).
- **Idempotent:** re-running rewrites the rule + replaces just the
  `adorable` entry in `mcp.json`.
- **`--db` resolution:** relative paths resolve against the project root,
  not your shell's cwd. So `--db my-project.db` works the same
  whether you run from the project root or a subdirectory.

Without `--db`, only the rule installs. Re-run with `--db` once your
project is analyzed.

Restart Cursor (or reload the window) so the rule + MCP server are
picked up.

### Continue.dev

```bash
adorable install continue --db /abs/path/to/my-project.db
```

- **Scope:** user-scoped.
- **Writes:** `$CONTINUE_GLOBAL_DIR/config.json` (or
  `~/.continue/config.json` by default). Merges two things:
  - `customCommands[adorable]` — a `/adorable` slash command whose
    prompt is the SKILL.md body. Typing `/adorable` in a Continue chat
    invokes the skill explicitly.
  - `mcpServers.adorable` — wired only when `--db` is provided.
- **Other entries preserved:** other `customCommands`, other
  `mcpServers`, and any other top-level keys in `config.json` are
  passed through untouched.
- **Idempotent:** the adorable customCommand entry is replaced on
  re-install, so re-running doesn't grow a list of duplicates.
- **`--db` resolution:** absolute paths recommended (Continue is
  user-scoped, so relative paths resolve against the shell cwd, which
  may not be your project root).

> Note: Continue is moving from `~/.continue/config.json` to
> `~/.continue/config.yaml` (with `prompts:` blocks in place of
> `customCommands`). We write the JSON form today — it's supported but
> documented as deprecated. A follow-up will detect which style the
> user is on.

Restart Continue (or reload your editor).

### VS Code + Copilot Chat

```bash
cd ~/my-project
adorable install vscode --db my-project.db
```

- **Scope:** project-scoped — run from the project root.
- **Writes:**
  - `.github/copilot-instructions.md` — always. **Upserts a delimited
    Veoable section**:

    ```markdown
    <!-- adorable:start v=1 (managed by `adorable install vscode`) -->
    ...
    <!-- adorable:end -->
    ```

    Your existing instructions outside the markers are preserved
    verbatim, including content before AND after our section. If the
    file doesn't exist, it's created.
  - `.vscode/mcp.json` — only when `--db` is provided. Uses VS Code's
    `servers` schema (not `mcpServers` like Cursor) with
    `type: 'stdio'`.
- **Idempotent:** re-running replaces only the delimited region. If a
  previous half-broken install left two marker pairs, both are
  collapsed into a single canonical section.
- **`--db` resolution:** relative paths resolve against the project
  root, same as Cursor.

The Copilot instructions section is intentionally short (~400 tokens).
`copilot-instructions.md` is injected into every Copilot Chat request,
so we keep it lean and rely on the `describe_skill` MCP tool to surface
the full SKILL.md mid-conversation when needed.

Restart VS Code (or reload the window).

---

## The `--db` flag

The `--db` flag tells the install command where your analyzed graph
lives. It's optional for `cursor`, `continue`, and `vscode` (the rule
or slash command still installs without it; the MCP server entry is
just deferred). For `claude-code` it's not accepted — Claude Code's
MCP config is registered with `claude mcp add` separately, not by
`adorable install`.

**Path resolution rules:**

| Client       | Relative paths resolve against        |
| ------------ | ------------------------------------- |
| cursor       | the current working directory (the project root, since `install cursor` is run from there) |
| vscode       | the current working directory (same reason as cursor)                                       |
| continue     | the current working directory (Continue is user-scoped — pass an absolute path if you run from elsewhere) |
| claude-code  | n/a (not accepted)                    |

If in doubt, pass an absolute path:

```bash
adorable install continue --db "$HOME/my-project/my-project.db"
```

---

## Verifying the install

After installing into a client:

1. **Confirm the skill file landed.**

   ```bash
   # claude-code
   head ~/.claude/skills/adorable/SKILL.md
   # cursor (run from project root)
   head .cursor/rules/adorable.mdc
   # continue
   jq '.customCommands[] | select(.name == "adorable") | .description' ~/.continue/config.json
   # vscode (run from project root)
   grep -A 2 'adorable:start' .github/copilot-instructions.md
   ```

2. **Confirm the MCP server entry is wired** (where applicable):

   ```bash
   # cursor
   jq '.mcpServers.adorable' .cursor/mcp.json
   # continue
   jq '.mcpServers.adorable' ~/.continue/config.json
   # vscode
   jq '.servers.adorable' .vscode/mcp.json
   # claude-code
   claude mcp list  # if Claude Code is installed
   ```

3. **Restart the client** (or reload the window).

4. **Ask a question that should trigger Veoable**:

   > *"What does this app do?"*
   >
   > *"What endpoints does the backend expose?"*
   >
   > *"What happens when a user submits the login form?"*

   You should see the agent invoke an Veoable tool (the exact UI
   varies by client — Claude Code prints "🔧 tool: list_repositories",
   Cursor shows a 🛠️ chip in chat, etc.).

5. **If the agent skips Veoable**, ask it to call `describe_skill`
   explicitly:

   > *"Call describe_skill, then answer."*

   That returns the full skill content mid-session. If the agent still
   doesn't have it available, the MCP server isn't reachable — see
   [Troubleshooting](#troubleshooting).

---

## Updating the skill

When you upgrade Veoable (e.g. `git pull` + `pnpm install-cli`), the
SKILL.md content may change. Re-run the install command for each client
you use:

```bash
adorable install --auto --db ~/my-project/my-project.db
```

All adapters are idempotent — your existing client-specific content
outside Veoable's marker blocks (especially in
`.github/copilot-instructions.md`) is preserved.

---

## Removing the skill

There's no `adorable uninstall` command yet. To remove manually:

```bash
# claude-code
rm -rf ~/.claude/skills/adorable
# (also remove the MCP entry: `claude mcp remove adorable`)

# cursor (from project root)
rm .cursor/rules/adorable.mdc
# Edit .cursor/mcp.json and delete the "adorable" key under "mcpServers".

# continue
# Edit ~/.continue/config.json:
#   - Remove the "adorable" entry from customCommands.
#   - Remove the "adorable" entry from mcpServers.

# vscode (from project root)
# Edit .github/copilot-instructions.md and delete the block between:
#   <!-- adorable:start v=1 ... -->
#   <!-- adorable:end -->
# Edit .vscode/mcp.json and delete the "adorable" key under "servers".
```

---

## What `adorable install` doesn't do

For safety, the install command refuses to touch a few things:

- **Claude Code's `~/.claude.json`** — `claude mcp add` is the official
  way to register an MCP server. We don't compete with it.
- **The actual MCP server process** — `adorable install` writes config
  only. The server runs when the LLM client launches it on demand.
- **Building the graph DB** — you need `adorable project analyze` (or
  `adorable analyze` for a single repo) before the MCP server has data
  to serve. The install command's next-steps remind you of this.
- **Restarting the client** — every adapter's next-steps print a
  "restart your client" reminder, but the install command can't do it
  for you.
- **Choosing the LLM the client uses to think.** The install adapters
  write the canonical SKILL.md and an MCP server entry; what LLM the
  client routes user prompts to (OpenAI, Anthropic, OpenRouter, a
  local Ollama) is the client's own setting. See [Using OpenRouter
  (or any OpenAI-compatible endpoint)](userguide.md#using-openrouter-or-any-openai-compatible-endpoint)
  in the user guide for the per-client details — short version:
  Cursor and Continue both support OpenRouter as a backend out of the
  box; Claude Code and VS Code Copilot use their native subscriptions.
  If you're an OpenRouter-only user with no Claude Desktop / Copilot
  subscription, the easiest path is `adorable chat --provider openrouter`
  instead of an MCP install.

---

## Troubleshooting

### "The agent doesn't recognize the skill / never calls Veoable tools"

Most common: the client process started before the install ran, and
hasn't been restarted. Fully quit the client (not just close the
window) and reopen.

If a restart doesn't help:

- For **Claude Code / Cursor / Continue / VS Code Copilot**, ask the
  agent to call `describe_skill` explicitly. If it returns the
  SKILL.md content, the MCP server is reachable but the trigger-shape
  matching isn't firing — try a more explicit question (e.g.
  *"Use Veoable to list every API endpoint in this codebase"*).
- If `describe_skill` fails or isn't found, the MCP server isn't
  reachable. Verify the path in `mcp.json` or `config.json` matches
  the graph DB you actually built (`ls -la <path>`).

### "I see the skill in `~/.claude/skills/`, but Claude Code doesn't surface it"

Claude Code 1.x scans the skills directory at startup. Restart Claude
Code with a hard quit (`Cmd+Q` on macOS, not just close the window).

### "Cursor says my .mdc rule is invalid"

`adorable install` writes Cursor's expected frontmatter:

```yaml
---
description: <one-line trigger description>
alwaysApply: false
---
<body>
```

If Cursor complains about `name` or other fields, your Cursor version
may be using an older rules format — check Cursor's docs and adjust the
frontmatter by hand, or upgrade Cursor.

### "I want to use a different graph DB"

Re-run with the new `--db`:

```bash
adorable install cursor --db /path/to/different-graph.db
```

The merge logic replaces only the `adorable` entry in `mcp.json` /
`config.json`; other servers are untouched.

### "`adorable install --auto` skips a client I have installed"

The detection signal looks for the client's config directory
(`~/.claude`, `.cursor/`, etc.) in the expected location. If you've
relocated it (e.g. `$CLAUDE_CONFIG_DIR=/elsewhere`), set the env var
in your shell or pass an explicit `adorable install <client>` instead.

### "My `.github/copilot-instructions.md` has duplicate Veoable sections"

A half-broken previous install or a copy-paste error can leave two
marker pairs. Re-run `adorable install vscode` — the upsert collapses
both into a single canonical section automatically.

### "The MCP server crashes on startup"

Two common causes:

- **The graph DB doesn't exist yet.** Run `adorable project analyze`
  first.
- **The DB path in the config is wrong.** Open the relevant `mcp.json`
  / `config.json` and confirm `args` contains the absolute path to
  your graph DB.

You can also test the server directly:

```bash
adorable serve /abs/path/to/graph.db
# (it should print a startup banner; Ctrl-C to stop)
```

---

## What's next

- **Open the [MCP tools guide](mcp-tools-guide.md)** for the full catalog
  of what Veoable can answer once it's installed.
- **For live updates** during a session (so your edits reflect in the
  agent's next answer), leave a watcher running in another terminal:

  ```bash
  adorable project watch my-project.project.json --incremental --on-demand
  # Press 'r' before asking the agent a question that needs fresh data.
  ```

- **Missing your favorite client?** Track [#363](https://github.com/mudit70/adorable/issues/363)
  — ChatGPT custom GPT, OpenClaw, and marketplace listings are planned
  follow-ups.
