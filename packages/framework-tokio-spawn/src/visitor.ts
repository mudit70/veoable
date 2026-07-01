import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideProcess } from '@adorable/schema';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';

/**
 * tokio::spawn visitor (#538).
 *
 * One emit per `tokio::spawn(...)` / `tokio::task::spawn(...)` call.
 *
 * Emitted ClientSideProcess shape:
 *   - kind: 'other'  (the canonical ProcessKind enum has no
 *      `background_task`; using the existing catch-all avoids a
 *      schema bump for a single plugin. A follow-up can add the kind
 *      if other languages want the same category.)
 *   - name: `tokio::spawn` (call-site-stable; we synthesize a unique
 *      id via (sourceFileId, sourceLine, name) so multiple sites in
 *      the same file get distinct nodes)
 *   - functionId: the enclosing function's FunctionDefinition id
 *      (so BFS that finds the process can hop into the spawn call's
 *      function and follow CALLS_FUNCTION edges into the spawned
 *      future's body, which lang-rust already extracts)
 *   - framework: 'tokio-spawn'
 *
 * What we deliberately don't do:
 *   - `tokio::spawn_blocking(...)` — different semantics (blocking
 *     thread pool, usually sync work). Skipped to keep the process
 *     category coherent.
 *   - Resolve the spawned future's inner callee to a separate
 *     FunctionDefinition — the future body is already in the call
 *     graph via the enclosing function's CALLS_FUNCTION edges, so
 *     reachability works without it.
 */
export function createTokioSpawnVisitor(): RustFrameworkVisitor {
  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!isTokioSpawnCall(node)) return;

      // We need an enclosing function so BFS has a starting point that
      // composes with the existing call graph. Top-level / module-init
      // spawns (rare in idiomatic Rust — `main()` exists as a normal
      // function) get skipped.
      const enclosing = ctx.enclosingFunction;
      if (!enclosing) return;

      const sourceLine = node.startPosition.row + 1;
      const name = 'tokio::spawn';
      const process: ClientSideProcess = {
        nodeType: 'ClientSideProcess',
        id: idFor.clientSideProcess({
          sourceFileId: ctx.sourceFile.id,
          sourceLine,
          name,
        }),
        kind: 'other',
        name,
        functionId: enclosing.id,
        sourceFileId: ctx.sourceFile.id,
        sourceLine,
        framework: 'tokio-spawn',
        repository: ctx.sourceFile.repository,
        evidence: {
          filePath: ctx.sourceFile.filePath,
          lineStart: sourceLine,
          lineEnd: node.endPosition.row + 1,
          snippet: node.text.length <= 300 ? node.text : node.text.slice(0, 299) + '…',
          confidence: 'exact',
        },
      };
      ctx.emitNode(process);
    },
  };
}

/**
 * Match `tokio::spawn(...)` or `tokio::task::spawn(...)`. tree-sitter's
 * `call_expression` has a `function` child carrying the callee
 * expression. We compare the callee path's last segment textually and
 * verify the path starts with `tokio`.
 *
 * `tokio::spawn_blocking` is intentionally rejected — its callee's
 * last segment is `spawn_blocking`, not `spawn`.
 *
 * `spawn(...)` alone (after `use tokio::spawn;`) is not matched in
 * v1. Adding it would need the per-crate import scanner consulted at
 * each call site, mirroring framework-tonic's bare-`async_trait` lift.
 */
function isTokioSpawnCall(callNode: SyntaxNode): boolean {
  const callee = callNode.childForFieldName('function');
  if (!callee) return false;
  // tree-sitter-rust models `tokio::spawn` as a `scoped_identifier`.
  // The grammar fields are `path` (the prefix) and `name` (the last
  // segment).
  if (callee.type !== 'scoped_identifier') return false;
  const nameNode = callee.childForFieldName('name');
  const pathNode = callee.childForFieldName('path');
  if (!nameNode || !pathNode) return false;
  if (nameNode.text !== 'spawn') return false;
  // Accept exactly `tokio::spawn` and `tokio::task::spawn`. The path
  // is what's BEFORE the last `::spawn`, so it's either `tokio` or
  // `tokio::task`.
  const path = pathNode.text;
  return path === 'tokio' || path === 'tokio::task';
}
