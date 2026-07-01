import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideAPICaller, type HttpEgressConfidence } from '@veoable/schema';
import { detectExternalUrl } from '@veoable/plugin-api';
import { hasCrateImport, type RustFrameworkVisitor, type RustVisitContext } from '@veoable/lang-rust';

/**
 * reqwest visitor.
 *
 * One emit per outbound HTTP call site (sqlx/axios pattern).
 *
 * Detected:
 *   - `reqwest::<verb>(URL)` / `reqwest::blocking::<verb>(URL)`
 *   - `<receiver>.<verb>(URL)` where receiver name matches a client
 *     heuristic (`client` / `http` / `api` / `reqwest`, plus the
 *     `self.<name>` form). Per-file gate: file must `use reqwest::*`
 *     to enable the method-call shape, so an unrelated method call on
 *     a same-named local var doesn't false-positive across the project.
 *
 * URL extraction is conservative: only a bare string-literal first arg
 * resolves. format!(...), &url, identifier args → urlLiteral=null,
 * egressConfidence='dynamic'. Template-part recovery from
 * format!("...{}",x) is a deliberate follow-up — the TS side has
 * resolveCallerUrl for this and it's nontrivial.
 */

const HTTP_VERBS: ReadonlyMap<string, string> = new Map([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['delete', 'DELETE'],
  ['patch', 'PATCH'],
  ['head', 'HEAD'],
]);

const RECEIVER_RE = /^(?:self\.)?(?:.*(?:client|http|api|reqwest).*)$/i;

export function createReqwestVisitor(): RustFrameworkVisitor {
  // Per-file gate — only enable the method-call shape when the file
  // imports reqwest at all. Avoids "any `.get(...)` on any var" false
  // positives across unrelated code (e.g. a hash-map's `.get(key)`).
  const fileEnabled = new Map<string, boolean>();
  const enabledFor = (filePath: string, root: SyntaxNode): boolean => {
    const cached = fileEnabled.get(filePath);
    if (cached !== undefined) return cached;
    const enabled = hasCrateImport(root, 'reqwest');
    fileEnabled.set(filePath, enabled);
    return enabled;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!ctx.enclosingFunction) return;

      const fn = node.childForFieldName('function');
      if (!fn) return;

      // ── `reqwest::<verb>(URL)` / `reqwest::blocking::<verb>(URL)` ──
      const scopedVerb = matchReqwestScopedVerb(fn);
      if (scopedVerb) {
        emitCaller(ctx, node, scopedVerb);
        return;
      }

      // ── `<receiver>.<verb>(URL)` ────────────────────────────────────
      if (fn.type !== 'field_expression') return;
      if (!enabledFor(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fieldNode = fn.childForFieldName('field');
      const methodName = fieldNode?.text;
      if (!methodName) return;
      const httpMethod = HTTP_VERBS.get(methodName);
      if (!httpMethod) return;

      const receiverNode = fn.childForFieldName('value');
      if (!receiverNode) return;
      if (!RECEIVER_RE.test(receiverNode.text)) return;

      emitCaller(ctx, node, httpMethod);
    },
  };
}

function emitCaller(ctx: RustVisitContext, callNode: SyntaxNode, httpMethod: string): void {
  if (!ctx.enclosingFunction) return;

  const argsNode = callNode.childForFieldName('arguments');
  if (!argsNode) return;

  const firstArg = firstNonPunctChild(argsNode);
  if (!firstArg) return;

  const { urlLiteral, egressConfidence } = resolveUrlArg(firstArg);

  const sourceLine = callNode.startPosition.row + 1;
  const snippetText = callNode.text;
  const evidence = {
    filePath: ctx.sourceFile.filePath,
    lineStart: sourceLine,
    lineEnd: callNode.endPosition.row + 1,
    snippet: snippetText.length <= 500 ? snippetText : snippetText.slice(0, 499) + '…',
    confidence: egressConfidence === 'exact' ? ('exact' as const) : ('heuristic' as const),
  };

  // Classify external vs internal (only meaningful when we have a
  // literal URL). The MCP server's /external-callers and
  // /external-hosts views key off `isExternal` + `externalHost`.
  const ext = urlLiteral ? detectExternalUrl(urlLiteral) : { isExternal: false, host: null };

  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine,
      urlLiteral,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine,
    httpMethod,
    urlLiteral,
    egressConfidence,
    framework: 'reqwest',
    repository: ctx.sourceFile.repository,
    evidence,
    ...(ext.isExternal ? { isExternal: true, externalHost: ext.host } : {}),
  };
  ctx.emitNode(caller);
  ctx.emitEdge({
    edgeType: 'MAKES_REQUEST',
    from: ctx.enclosingFunction.id,
    to: caller.id,
  });
}

/**
 * Match `reqwest::<verb>` or `reqwest::blocking::<verb>` (and return
 * the canonical HTTP method). Returns null otherwise.
 */
function matchReqwestScopedVerb(fn: SyntaxNode): string | null {
  if (fn.type !== 'scoped_identifier') return null;
  const path = fn.childForFieldName('path');
  const name = fn.childForFieldName('name');
  if (!path || !name) return null;
  const verb = HTTP_VERBS.get(name.text);
  if (!verb) return null;
  // `reqwest::<verb>` (path.text === 'reqwest')
  if (path.text === 'reqwest') return verb;
  // `reqwest::blocking::<verb>` (path.text === 'reqwest::blocking')
  if (path.text === 'reqwest::blocking') return verb;
  return null;
}

function firstNonPunctChild(argsNode: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < argsNode.childCount; i++) {
    const c = argsNode.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    return c;
  }
  return null;
}

/**
 * Resolve a single argument to (urlLiteral, egressConfidence).
 * Mirrors the TS side's `resolveCallerUrl` but only the literal path:
 * anything that isn't a string literal yields dynamic. References
 * (`&url`) are peeled once.
 */
function resolveUrlArg(arg: SyntaxNode): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  let n: SyntaxNode = arg;
  // `&url` / `&mut url` → peel the reference.
  if (n.type === 'reference_expression') {
    const value = n.childForFieldName('value');
    if (value) n = value;
  }
  if (n.type === 'string_literal' || n.type === 'raw_string_literal') {
    const lit = stripStringQuotes(n.text);
    if (lit !== null) return { urlLiteral: lit, egressConfidence: 'exact' };
  }
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}

function stripStringQuotes(text: string): string | null {
  if (text.startsWith('r#"') && text.endsWith('"#')) return text.slice(3, -2);
  if (text.startsWith('r"') && text.endsWith('"')) return text.slice(2, -1);
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"');
  }
  return null;
}
