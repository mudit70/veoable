# @veoable/migrate-from-adorable

One-shot migration command that upgrades a project from the
`adorable`-era package namespace (`@adorable/*` + `adorable` CLI +
`"adorable"` MCP key) to the `veoable`-era namespace.

## Usage

```bash
# Preview what would change (safe — no files touched):
npx @veoable/migrate-from-adorable

# Apply the changes:
npx @veoable/migrate-from-adorable --apply

# Point at a specific directory:
npx @veoable/migrate-from-adorable ./packages/my-service --apply

# Show every file:line rewrite the migrator applied:
npx @veoable/migrate-from-adorable --apply --show-files
```

The command defaults to dry-run mode. `--apply` is required to write
back to disk — this keeps `npx …-migrate-from-adorable` in the wrong
CWD from being a footgun.

## What it rewrites

| Surface | Change |
|---------|--------|
| Source imports (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`) | `from '@adorable/X'` → `from '@veoable/X'` |
| `package.json` `name` | `"adorable"` → `"veoable"` (workspace root case only) |
| `package.json` `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies` | Every `"@adorable/X"` key renamed |
| `package.json` `bin` | `bin.adorable` → `bin.veoable` |
| `package.json` `scripts` | `scripts.adorable` → `scripts.veoable` |
| MCP configs (`.mcp.json`, `mcp.json`, `claude_desktop_config.json`) | `mcpServers.adorable` → `mcpServers.veoable` |
| CLI usage in `.md` / `.sh` / `.zsh` / `.bash` | `adorable <subcommand>` → `veoable <subcommand>` when followed by a known verb (analyze, serve, chat, install, project, tools) |

## What it leaves alone

- **Historical URLs** — `https://github.com/mudit70/adorable/...` links
  in docs stay intact so they keep resolving.
- **The bare word `adorable`** in prose — "originally shipped as
  adorable" doesn't get rewritten. The migrator only rewrites CLI
  usage where a subcommand keyword follows.
- **`node_modules` / `.git` / `dist` / `build` / `coverage`** — always
  excluded from the walk.
- **Fixture files** where the string "adorable" is part of test data
  (e.g. `<a href="/search?q=adorable">`).

## License notice

The upstream `mudit70/adorable` project was released under the **MIT
License**. `mudit70/veoable` is released under **Apache-2.0** (decided
2026-06-30 during open-source readiness review — see
[`mudit70/adorable#516`](https://github.com/mudit70/adorable/issues/516)).

Both are permissive and compatible with each other and with common
downstream licenses. If you've been distributing derivative work under
MIT because you took an MIT dependency, you now inherit Apache-2.0's
patent-grant provisions as well.

## Programmatic use

Every transform is exported from the package's main entry point so
tooling (IDE extensions, custom codemods) can call them directly:

```ts
import {
  migrateProject,
  migratePackageJsonText,
  migrateMcpConfigText,
  rewriteScopeInText,
  makeOptions,
} from '@veoable/migrate-from-adorable';

const changes = await migrateProject(
  makeOptions({ root: '/path/to/project', dryRun: true }),
);
```

Each transform returns a `MigrationChange[]` with `file`, `line`,
`kind`, `before`, and `after` fields — enough to render a preview
panel without re-reading source.
