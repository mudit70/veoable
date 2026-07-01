import type { NodeBatch } from '@adorable/schema';
import type { ProjectHandle, ProjectOptions } from './types.js';

/**
 * Abstract framework visitor. Language plugins define the concrete shape
 * (what AST-node categories they dispatch on, what payload each handler
 * receives) when they are implemented. `@adorable/plugin-api` intentionally
 * does not pin the visitor shape here because the right abstraction is
 * language-specific: ts-morph `SyntaxKind` visitors look very different
 * from libcst `Visitor` classes from go/ast walkers.
 *
 * Framework plugins that target a specific language should import the
 * concrete visitor type from that language plugin's public API, not from
 * here. This opaque placeholder exists so the `LanguagePlugin` /
 * `FrameworkPlugin` interfaces remain language-agnostic at the core layer.
 */
export interface FrameworkVisitor {
  /**
   * The language plugin id this visitor targets. Must match a
   * `LanguagePlugin.id` at registration time or registration throws.
   */
  readonly language: string;
}

/**
 * A language plugin owns the AST parser for a single language and produces
 * the foundational call graph (`SourceFile`, `FunctionDefinition`,
 * `IMPORTS`, `EXPORTS`, `DEFINED_IN`, `CALLS_FUNCTION`). It exposes a
 * visitor registration hook so framework plugins can share its single AST
 * walk and emit framework-specific nodes in the same pass.
 *
 * One language plugin per language. A `stack` is not a language plugin —
 * stacks are runtime compositions of one language plugin plus N framework
 * plugins.
 */
export interface LanguagePlugin {
  /** Stable id, e.g. `'ts'`, `'python'`, `'go'`, `'rust'`, `'java'`. */
  readonly id: string;

  /**
   * File extensions this plugin claims ownership of. The orchestrator
   * routes files to language plugins by extension match. Extensions
   * include the leading dot, e.g. `['.ts', '.tsx', '.js', '.jsx']`.
   */
  readonly fileExtensions: readonly string[];

  /**
   * Load a project. Called once per analysis run; returns an opaque
   * handle the plugin uses to resolve cross-file symbols across
   * subsequent `extractFile` calls.
   */
  loadProject(opts: ProjectOptions): Promise<ProjectHandle>;

  /**
   * Parse a single file and emit a `NodeBatch` containing the
   * language-level nodes/edges for that file, plus anything the
   * registered framework visitors emitted during the same walk.
   *
   * Plugins MUST NOT write to the graph store from inside this method.
   * The returned batch is committed transactionally by the orchestrator.
   */
  extractFile(project: ProjectHandle, filePath: string): Promise<NodeBatch>;

  /**
   * Register a framework visitor. Called once per framework plugin at
   * orchestrator startup, before any `extractFile` call. Throws if the
   * visitor's `language` does not match this plugin's `id`.
   */
  registerVisitor(visitor: FrameworkVisitor): void;
}
