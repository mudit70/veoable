# Contributing to Veoable

Thank you for taking the time to contribute. This document covers the
mechanics of getting a change from your machine into `main`, plus the
architectural rules that every contribution must respect.

> **Rename note.** Veoable is a rename of
> [`adorable`](https://github.com/mudit70/adorable); until the
> mechanical-rename PR lands, package names inside the workspace are still
> `@adorable/*` and the CLI is still `adorable`. Please read those names
> as "veoable" and expect a global find/replace in a coordinated PR
> tracked in [`mudit70/adorable#516`](https://github.com/mudit70/adorable/issues/516).

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Making a change](#making-a-change)
- [Architectural rules (load-bearing)](#architectural-rules-load-bearing)
- [Pull request checklist](#pull-request-checklist)
- [Reporting bugs & security issues](#reporting-bugs--security-issues)
- [Code of conduct](#code-of-conduct)

## Ways to contribute

- **Reporting bugs.** Use the "Bug report" issue template. A minimal
  reproducer beats a paragraph of description.
- **Requesting features.** Use the "Feature request" template. Frame it
  in terms of the analysis problem you're trying to solve; that helps the
  maintainers pick the right layer to add support at.
- **Adding a framework plugin.** Framework plugins are the most common
  contribution shape. Follow the language-plugin rule (§Architectural
  rules) so we don't accumulate parser duplication.
- **Improving language plugins, the flow-stitcher, or the CLI/MCP surface.**
  Bigger blast radius; open an issue first so we can agree on the shape
  before you write the code.
- **Documentation.** The user guide, framework matrix, and MCP tools guide
  are living documents. Fixes and expansions are welcome.

## Development setup

### Prerequisites

- **Node.js 20+** (LTS recommended).
- **pnpm 10** — the workspace's `packageManager` field pins this. Enable
  via `corepack enable` or install directly from
  <https://pnpm.io/installation>.
- **Git**.

For running the analyzer's language plugins locally you may also need:

- **Python 3.10+** if you're working on `lang-py` or a Python framework
  plugin.
- **Go 1.21+** if you're working on `lang-go` or a Go framework plugin.
- **Rust 1.75+** if you're working on `lang-rust` or a Rust framework
  plugin.

Native modules (`better-sqlite3`, `tree-sitter-*`) sometimes require Python
and a C toolchain to build. On macOS install Xcode Command Line Tools; on
Linux install `build-essential` and `python3`.

### Clone + install

```bash
git clone https://github.com/mudit70/veoable
cd veoable
pnpm install
```

The first install compiles native modules and can take a few minutes.

### Build + test

Common workspace scripts (from the repo root):

```bash
pnpm build             # build every workspace package
pnpm test              # unit tests (vitest)
pnpm test:integration  # integration tests (vitest projects)
pnpm lint              # eslint across packages/
pnpm format            # prettier write
pnpm format:check      # prettier check (CI-friendly)
```

Package-scoped runs:

```bash
pnpm --filter @veoable/cli build
pnpm --filter @veoable/framework-express test
```

### Install the CLI locally

```bash
pnpm install-cli   # links @veoable/cli globally so `veoable` is on your PATH
pnpm uninstall-cli # reverses the above
```

## Making a change

1. **Search existing issues.** Someone may already be tracking it.
2. **Open an issue for anything non-trivial.** Bug fixes with obvious
   reproducers can skip this; new features, new plugins, or architectural
   changes should have a design discussion in an issue first.
3. **Branch from `main`.** Use a descriptive branch name (e.g.
   `feature/framework-hono-plugin`, `fix/flow-stitcher-cross-repo-edge`).
4. **Write the code, then the tests.** Every plugin ships with a fixture
   in `test-apps/` (or equivalent) and a test that asserts the plugin
   detects it.
5. **Run `pnpm lint` + `pnpm test` + `pnpm build` locally.** CI runs the
   same commands; catching failures locally saves the round-trip.
6. **Update docs.** If your change affects user-visible behavior, update
   `docs/userguide.md` (framework matrix, CLI examples, MCP tool docs, or
   quickstart as appropriate).
7. **Open a PR.** Fill out the PR template — the checklist exists to catch
   the common "tests written but docs forgot" bug.

## Architectural rules (load-bearing)

Two rules protect the codebase from the worst kind of drift; a violation
usually shows up months later as duplicated parser code and cross-repo
edge bugs. Reviewers will push back on PRs that break either.

### 1. Split parsers by language, not by framework

One `LanguagePlugin` per language owns the AST walk (`lang-ts`, `lang-py`,
`lang-go`, …). All `FrameworkPlugin`s targeting that language register
visitors that share the single walk.

**A framework plugin must never instantiate its own parser** (`new Project()`
from ts-morph, `libcst`, `tree-sitter-*`) for source files in that
language. If you find yourself wanting to, extend the LanguagePlugin's
visitor context with a helper so every framework plugin benefits.

*Sanctioned exception:* `FrameworkPlugin.onProjectLoaded` may parse files
the language plugin does not claim — Prisma schemas, Django models,
OpenAPI specs, webpack configs. That's fine; it's the "framework-owned
non-source manifest" case.

### 2. Split graphs by repository

Multi-repo projects analyze each repo independently and stitch results
in the flow-stitcher layer. **Do not share AST state across repos.**

Cross-cutting concerns — cross-file symbol resolution, manifest discovery,
constant propagation, workspace-alias resolution — belong in the language
plugin or in `plugin-api`, **not** duplicated across framework plugins.
Three frameworks each implementing the same resolution logic is a code
smell; extract it down one layer.

### Testing invariants

- **Every plugin ships with a fixture.** Fixtures live under
  `test-apps/` (or the plugin's own `tests/fixtures/`) and represent a
  minimal, realistic use of the framework.
- **Detection tests are cheap; regression tests are the goal.** Assert
  the specific edges / nodes the plugin should emit, not just that it
  ran without throwing.
- **Cross-repo stitching gets its own test.** If your change touches the
  flow-stitcher or a plugin that participates in cross-repo edges, add a
  fixture with two-plus repos and assert the stitched flow.

## Pull request checklist

Copy this into every PR (the PR template pre-fills it):

- [ ] Tests added or updated (unit + integration where applicable).
- [ ] `pnpm lint`, `pnpm test`, `pnpm test:integration`, and `pnpm build`
      all pass locally.
- [ ] `pnpm format:check` passes.
- [ ] `docs/userguide.md` (or the relevant doc) updated for user-visible
      changes.
- [ ] `CHANGELOG.md` entry added under the `## Unreleased` heading.
- [ ] No new framework plugin instantiates its own parser (architectural
      rule 1).
- [ ] No new cross-repo AST sharing (architectural rule 2).
- [ ] Breaking change? Flagged in the PR body **and** the changelog with
      a migration note.

## Reporting bugs & security issues

- **Non-security bugs:** open an issue with the "Bug report" template.
- **Security vulnerabilities:** do NOT open a public issue. Follow the
  process in [`SECURITY.md`](./SECURITY.md).

## Code of conduct

By participating in this project you agree to abide by the
[Contributor Covenant](./CODE_OF_CONDUCT.md). Report unacceptable
behavior via the address listed in that file.
