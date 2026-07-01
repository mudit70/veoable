import type { Node, Project } from 'ts-morph';
import type { FrameworkVisitor } from '@adorable/plugin-api';
import type { FunctionDefinition, SchemaEdge, SchemaNode, SourceFile as SchemaSourceFile } from '@adorable/schema';

/**
 * Context passed to a `TsFrameworkVisitor.onNode` callback for every
 * visited AST node. Exposes just enough state for a framework plugin
 * to decide what to emit:
 *
 *  - `sourceFile`: the `SourceFile` schema node for the file currently
 *    being walked.
 *  - `enclosingFunction`: the `FunctionDefinition` node that the
 *    current AST node lives inside, or `undefined` at module top
 *    level. Framework plugins use this to attribute emitted nodes/
 *    edges to the correct owner (e.g. an Express visitor attaching a
 *    route handler to the function that contains `app.get(...)`).
 *  - `project`: the underlying ts-morph `Project`. Exposed so framework
 *    plugins can do their own symbol resolution (`getType`, `findReferences`,
 *    etc.) when the node context alone isn't enough.
 *  - `emitNode(node)` / `emitEdge(edge)`: append to the batch being
 *    built for the current file. Both are validated by the caller when
 *    the batch is ultimately committed.
 *
 * The context itself is deliberately shallow. Framework plugins should
 * not mutate any field other than the batch via `emitNode`/`emitEdge`.
 *
 * IMPORTANT — lifetime: the same `TsVisitContext` instance is reused
 * across every dispatch within a single `extractFile` call. The walker
 * mutates `enclosingFunction` in place before each `onNode` invocation
 * to avoid allocating a fresh context per AST node (the hot path
 * dispatches once per node, which can be tens of thousands of times
 * for a real project). Visitors MUST NOT retain a reference to the
 * context past the synchronous return of `onNode`; if a visitor needs
 * to remember state across calls it must copy the fields it cares
 * about (e.g. `const enclosing = ctx.enclosingFunction`).
 */
export interface TsVisitContext {
  readonly sourceFile: SchemaSourceFile;
  readonly enclosingFunction: FunctionDefinition | undefined;
  readonly project: Project;
  /** Repository-root directory, for computing cross-file FunctionDefinition IDs. */
  readonly rootDir: string;
  /** Repository name, for computing cross-file content-addressed IDs. */
  readonly repository: string;
  emitNode(node: SchemaNode): void;
  emitEdge(edge: SchemaEdge): void;
}

/**
 * Concrete framework visitor shape for the TypeScript language plugin.
 *
 * Framework plugins that target TS (`id: 'express'`, `'react'`,
 * `'prisma'`, ...) implement this interface and have it invoked once
 * per visited AST node during `extractFile`. Plugins dispatch on
 * `SyntaxKind` (or whatever ts-morph predicate they prefer) internally —
 * this keeps the base interface small and lets framework plugins
 * evolve their visitor shape without changing the contract here.
 *
 * The visitor runs *after* the structural extractor has recorded its
 * nodes, so `ctx.enclosingFunction` is always the `FunctionDefinition`
 * that the structural walker emitted for the closest enclosing
 * function-shaped ancestor — no guessing, no re-walking.
 */
export interface TsFrameworkVisitor extends FrameworkVisitor {
  readonly language: 'ts';
  /**
   * Invoked once per AST node during the single walk performed by
   * `extractFile`. The visitor is free to inspect `node`, call
   * `ctx.emitNode` / `ctx.emitEdge` to add to the current file's
   * batch, and use `ctx.enclosingFunction` to attribute emissions.
   *
   * MUST be synchronous. The walker does not await the return value;
   * any Promise returned from `onNode` will be silently ignored and
   * may never settle. Framework plugins that need async work (e.g.
   * remote schema fetches) must perform it before/after the
   * `extractFile` pass, not from inside `onNode`.
   *
   * Throwing from `onNode` propagates out through `extractFile` —
   * this is intentional. A buggy visitor should fail loudly so the
   * pipeline operator can see the broken plugin, rather than
   * silently dropping emissions for the rest of the file.
   */
  onNode(ctx: TsVisitContext, node: Node): void;
}
