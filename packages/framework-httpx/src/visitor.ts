import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type ClientSideAPICaller, type HttpEgressConfidence } from '@adorable/schema';
import { detectExternalUrl } from '@adorable/plugin-api';
import type { PyFrameworkVisitor, PyVisitContext } from '@adorable/lang-py';

/**
 * Python HTTP-client visitor — covers httpx + requests.
 *
 * Detected shapes:
 *
 *   # Top-level convenience
 *   httpx.get("URL")
 *   requests.post("URL", json=...)
 *
 *   # Client / Session method chain
 *   with httpx.Client() as client: client.get("URL")
 *   async with httpx.AsyncClient() as client: await client.get("URL")
 *   session = requests.Session(); session.post("URL")
 *
 * Per-file framework attribution: when the file imports `httpx`, the
 * caller's `framework` is `'httpx'`; when it imports `requests`, it's
 * `'requests'`. The bare-method-chain shape is gated on at least one
 * of those imports being present in the file — same pattern as
 * framework-reqwest.
 */

const HTTP_VERBS: ReadonlyMap<string, string> = new Map([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['delete', 'DELETE'],
  ['patch', 'PATCH'],
  ['head', 'HEAD'],
  ['options', 'OPTIONS'],
]);

const RECEIVER_RE = /^(?:self\.)?(?:.*(?:client|http|api|session|requests|httpx).*)$/i;

interface FileFlags {
  importsHttpx: boolean;
  importsRequests: boolean;
}

export function createHttpxVisitor(): PyFrameworkVisitor {
  // Per-file cache of import flags. Lives in closure; same instance
  // across the analysis run.
  const flagsByFile = new Map<string, FileFlags>();
  const getFlags = (filePath: string, root: SyntaxNode): FileFlags => {
    let f = flagsByFile.get(filePath);
    if (!f) {
      f = scanModuleImports(root);
      flagsByFile.set(filePath, f);
    }
    return f;
  };

  return {
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'call') return;
      if (!ctx.enclosingFunction) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'attribute') return;

      const obj = fn.childForFieldName('object');
      const attr = fn.childForFieldName('attribute');
      if (!obj || !attr) return;

      const methodName = attr.text.toLowerCase();
      const httpMethod = HTTP_VERBS.get(methodName);
      if (!httpMethod) return;

      const flags = getFlags(ctx.sourceFile.filePath, node.tree.rootNode);

      const objText = obj.text;
      let framework: 'httpx' | 'requests' | null = null;

      // ── Top-level: `httpx.get(...)` / `requests.get(...)` ────────
      if (obj.type === 'identifier') {
        if (objText === 'httpx' && flags.importsHttpx) framework = 'httpx';
        else if (objText === 'requests' && flags.importsRequests) framework = 'requests';
      }

      // ── Method on a client/session-like receiver ─────────────────
      if (!framework) {
        if (!flags.importsHttpx && !flags.importsRequests) return;
        if (!RECEIVER_RE.test(objText)) return;
        // Pick the framework based on which import the file has. If
        // both are imported, prefer httpx (more modern; if both
        // exist, both endpoints get attributed somewhere — and we
        // don't have the receiver type, so this is the best heuristic).
        framework = flags.importsHttpx ? 'httpx' : 'requests';
      }

      emitCaller(ctx, node, httpMethod, framework);
    },
  };
}

function emitCaller(
  ctx: PyVisitContext,
  callNode: SyntaxNode,
  httpMethod: string,
  framework: 'httpx' | 'requests',
): void {
  if (!ctx.enclosingFunction) return;

  const args = callNode.childForFieldName('arguments');
  if (!args) return;

  const firstArg = firstPositionalArg(args);
  if (!firstArg) return;

  const { urlLiteral, egressConfidence } = resolveUrlArg(firstArg);

  const sourceLine = callNode.startPosition.row + 1;
  const snippet = callNode.text;

  const evidence = {
    filePath: ctx.sourceFile.filePath,
    lineStart: sourceLine,
    lineEnd: callNode.endPosition.row + 1,
    snippet: snippet.length <= 500 ? snippet : snippet.slice(0, 499) + '…',
    confidence: egressConfidence === 'exact' ? ('exact' as const) : ('heuristic' as const),
  };

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
    framework,
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
 * The `arguments` node in tree-sitter-python wraps positional and
 * keyword args. Return the FIRST positional arg if there is one,
 * otherwise the VALUE of a `url=...` keyword arg (a real-world form:
 * `requests.get(url="https://...")`). Returns null when neither is
 * present.
 */
function firstPositionalArg(args: SyntaxNode): SyntaxNode | null {
  let kwUrl: SyntaxNode | null = null;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') {
      if (kwUrl) continue;
      const nameNode = c.childForFieldName('name');
      const valueNode = c.childForFieldName('value');
      if (nameNode?.text === 'url' && valueNode) kwUrl = valueNode;
      continue;
    }
    return c;
  }
  return kwUrl;
}

function resolveUrlArg(arg: SyntaxNode): { urlLiteral: string | null; egressConfidence: HttpEgressConfidence } {
  if (arg.type === 'string') {
    const lit = stripPythonString(arg.text);
    if (lit !== null) return { urlLiteral: lit, egressConfidence: 'exact' };
  }
  if (arg.type === 'concatenated_string') {
    // `"foo" "bar"` adjacent-string concat. Concatenate the parts if
    // every child is a string; otherwise dynamic.
    let combined = '';
    for (let i = 0; i < arg.childCount; i++) {
      const c = arg.child(i);
      if (!c) continue;
      if (c.type !== 'string') return { urlLiteral: null, egressConfidence: 'dynamic' };
      const lit = stripPythonString(c.text);
      if (lit === null) return { urlLiteral: null, egressConfidence: 'dynamic' };
      combined += lit;
    }
    if (combined.length > 0) return { urlLiteral: combined, egressConfidence: 'exact' };
  }
  return { urlLiteral: null, egressConfidence: 'dynamic' };
}

/**
 * Strip Python string quotes from a string-node's raw text. Handles
 * single, double, triple, and the f/r/b/u prefixes. Returns null if
 * the string is an f-string (interpolated — can't recover statically
 * here) or anything weird; the caller falls back to dynamic.
 */
function stripPythonString(text: string): string | null {
  // Drop optional prefix (r, b, u, R, B, U, or combinations — NOT f).
  let s = text;
  // f-strings are interpolated; treat them as dynamic.
  if (/^[rRbBuU]*[fF]/.test(s)) return null;
  s = s.replace(/^[rRbBuU]+/, '');
  // Triple-quoted strings.
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return null;
}

/**
 * Walk top-level imports to find whether the file imports `httpx`
 * and/or `requests`. We accept any of:
 *   import httpx
 *   import httpx as hx                     (we don't track the alias)
 *   from httpx import Client, AsyncClient
 *   from httpx import *
 * Same for `requests`. Sub-module imports
 * (`from requests.adapters import HTTPAdapter`) still count as
 * importing requests, since the package is in scope.
 */
function scanModuleImports(rootNode: SyntaxNode): FileFlags {
  let importsHttpx = false;
  let importsRequests = false;

  const checkImportNode = (node: SyntaxNode): void => {
    // `import_statement`: contains `dotted_name` children.
    // `import_from_statement`: has a `module_name` field.
    if (node.type === 'import_statement') {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c) continue;
        if (c.type === 'dotted_name' || c.type === 'aliased_import') {
          const head = firstDottedNameSegment(c);
          if (head === 'httpx') importsHttpx = true;
          else if (head === 'requests') importsRequests = true;
        }
      }
    } else if (node.type === 'import_from_statement') {
      const modName = node.childForFieldName('module_name');
      if (modName) {
        const head = firstDottedNameSegment(modName);
        if (head === 'httpx') importsHttpx = true;
        else if (head === 'requests') importsRequests = true;
      }
    }
  };

  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (!child) continue;
    checkImportNode(child);
  }

  return { importsHttpx, importsRequests };
}

function firstDottedNameSegment(node: SyntaxNode): string | null {
  // `aliased_import` wraps the actual dotted_name; descend once.
  if (node.type === 'aliased_import') {
    const inner = node.childForFieldName('name') ?? node.child(0);
    if (inner) return firstDottedNameSegment(inner);
    return null;
  }
  // `dotted_name` is a sequence of identifiers separated by `.`.
  if (node.type === 'dotted_name') {
    const first = node.child(0);
    return first?.text ?? null;
  }
  if (node.type === 'identifier') return node.text;
  return null;
}
