import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type APIEndpoint, type SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { MCPServerRustPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/mcp-server-rust/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new MCPServerRustPlugin();
  const rust = new RustLanguagePlugin();
  rust.registerVisitor(plugin.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-mcp-server-rust visitor (#537)', () => {
  it('emits one APIEndpoint per #[tool(...)]-attributed method', async () => {
    const batch = await extract('src/main.rs');
    const patterns = endpoints(batch).map((e) => e.routePattern).sort();
    // Counter (increment, decrement_v2, reset, get) — 4 tools.
    // Note `decrement_v2` comes from `name = "..."` override, NOT
    // the method name `decrement`. `helper` has no #[tool] attr → not emitted.
    // Echo (echo) — 1 tool.
    // Scoped (scoped_op) via #[rmcp::tool(...)] — 1 tool.
    // Router (route) via `impl ToolRouter for Router` trait impl — 1 tool.
    // Total = 7.
    expect(patterns).toEqual([
      'mcp:decrement_v2',
      'mcp:echo',
      'mcp:get',
      'mcp:increment',
      'mcp:reset',
      'mcp:route',
      'mcp:scoped_op',
    ]);
  });

  it('marks every endpoint with httpMethod=TOOL + framework=mcp-server-rust', async () => {
    const batch = await extract('src/main.rs');
    const es = endpoints(batch);
    expect(es.length).toBeGreaterThan(0);
    for (const e of es) {
      expect(e.httpMethod).toBe('TOOL');
      expect(e.framework).toBe('mcp-server-rust');
    }
  });

  it('does NOT emit `helper` (untagged method) or `#[tool_router]` (impl-level decorator)', async () => {
    const batch = await extract('src/main.rs');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    // Defensive: ensure the negative cases stay negative.
    expect(patterns).not.toContain('mcp:helper');
    // tool_router is on the impl, not a method — never produces a
    // route, so it should not appear as a tool name either.
    expect(patterns).not.toContain('mcp:tool_router');
  });

  it('accepts both `#[tool]` (no args) and `#[tool(...)]` (args)', async () => {
    const batch = await extract('src/main.rs');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    // `reset` uses bare `#[tool]`; `increment` uses `#[tool(description = "...")]`.
    expect(patterns.has('mcp:reset')).toBe(true);
    expect(patterns.has('mcp:increment')).toBe(true);
  });

  it('honors a `name = "..."` override over the method name', async () => {
    const batch = await extract('src/main.rs');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    // `decrement` method has `#[tool(name = "decrement_v2", ...)]` — the
    // route must use the override, not the method name.
    expect(patterns.has('mcp:decrement_v2')).toBe(true);
    expect(patterns.has('mcp:decrement')).toBe(false);
  });

  it('skips past sibling attributes like `#[doc = "..."]` to find the `#[tool]`', async () => {
    const batch = await extract('src/main.rs');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    // `get` has `#[doc = "..."]` between the function and `#[tool(...)]`.
    // The walk must keep going past the doc attribute.
    expect(patterns.has('mcp:get')).toBe(true);
  });

  it('accepts scoped attribute paths like `#[rmcp::tool(...)]`', async () => {
    const batch = await extract('src/main.rs');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    expect(patterns.has('mcp:scoped_op')).toBe(true);
  });

  it('handles multiple impl blocks in the same file (Counter + Echo + Scoped)', async () => {
    const batch = await extract('src/main.rs');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns.filter((p) => p === 'mcp:increment').length).toBe(1);
    expect(patterns.filter((p) => p === 'mcp:echo').length).toBe(1);
    expect(patterns.filter((p) => p === 'mcp:scoped_op').length).toBe(1);
  });

  it('accepts the trait-impl form: `impl <Trait> for <Struct> { #[tool] fn ... }`', async () => {
    // `extractImplType` must pick the type AFTER `for` (Router),
    // not the trait name (ToolRouter). Pins the regression that
    // would surface as an unresolvable handlerFunctionId
    // (lang-rust keys methods on the impl-target, not the trait).
    const batch = await extract('src/main.rs');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    expect(patterns.has('mcp:route')).toBe(true);
  });
});

describe('framework-mcp-server-rust plugin activation', () => {
  function ctxWith({ files, deps }: { files: string[]; deps: Record<string, string> }) {
    return {
      rootDir: FIXTURE_ROOT,
      repository: 'fixture',
      files,
      packageJson: null,
      rustManifests: [{ relPath: 'Cargo.toml', dependencies: deps }],
    } as any;
  }

  it('appliesTo() returns true when an MCP Rust SDK crate is in Cargo.toml', () => {
    const plugin = new MCPServerRustPlugin();
    expect(plugin.appliesTo(ctxWith({ files: ['src/main.rs'], deps: { rmcp: '0.1' } }))).toBe(true);
  });

  it('appliesTo() returns false when no MCP Rust SDK crate is declared', () => {
    const plugin = new MCPServerRustPlugin();
    expect(plugin.appliesTo(ctxWith({ files: ['src/main.rs'], deps: { axum: '0.7' } }))).toBe(false);
  });

  it('appliesTo() returns false when no Rust files are discovered', () => {
    const plugin = new MCPServerRustPlugin();
    expect(plugin.appliesTo(ctxWith({ files: ['src/main.ts'], deps: { rmcp: '0.1' } }))).toBe(false);
  });
});
