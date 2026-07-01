import { Node, type CallExpression, type Expression } from 'ts-morph';
import { idFor, type ClientSideAPICaller } from '@adorable/schema';
import { recordConfidenceDecision } from '@adorable/observability';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  resolveCallerUrl,
  detectExternalUrl,
  resolveToString,
} from '@adorable/lang-ts';

/**
 * Axios framework visitor (#128, #127, #532).
 *
 * Detects Axios HTTP calls:
 *   axios.get('/users')
 *   api.post('/users', data)      // api = axios.create({...})
 *   instance.put(`/users/${id}`)
 *   axios.delete(`/users/${id}`)
 *
 * The HTTP method is in the function name (not options object).
 * The first argument is the URL.
 *
 * #532 — when the receiver is an identifier bound to
 * `axios.create({ baseURL })`, the baseURL is composed onto the
 * extracted URL. This works for same-file and cross-file
 * declarations (the symbol resolver follows imports). Cross-file
 * fixture lives in `tests/fixtures/axios/basic/{clients,uses-client}.ts`.
 */

const AXIOS_HTTP_METHODS: ReadonlyMap<string, string> = new Map([
  ['get', 'GET'], ['post', 'POST'], ['put', 'PUT'],
  ['delete', 'DELETE'], ['patch', 'PATCH'], ['head', 'HEAD'],
  ['options', 'OPTIONS'],
]);

/** Receiver names that indicate an Axios instance. */
const AXIOS_RECEIVERS: ReadonlySet<string> = new Set([
  'axios', 'api', 'http', 'client',
  'axiosInstance', 'apiClient', 'httpClient',
  'baseBackendApi', 'baseApi', 'backendApi',
]);

export function createAxiosVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!ctx.enclosingFunction) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;

      const methodName = callee.getNameNode().getText();
      const httpMethod = AXIOS_HTTP_METHODS.get(methodName);
      if (!httpMethod) return;

      const receiver = callee.getExpression();
      const receiverText = receiver.getText();

      // #532 — If the receiver is an Identifier bound to
      // `axios.create({...})`, we know it's axios regardless of the
      // local name and we get the baseURL for free. Otherwise fall
      // back to the receiver-name heuristic.
      let baseURL: string | null = null;
      let isAxios = false;
      if (Node.isIdentifier(receiver) && receiverText !== 'axios') {
        baseURL = resolveAxiosInstanceBaseURL(receiver);
        if (baseURL !== null) isAxios = true;
        // Even when baseURL is null, the instance may still be axios
        // (e.g. `axios.create({ withCredentials: true })`). Check
        // whether the receiver was instantiated via `axios.create()`.
        if (!isAxios && isReceiverAnAxiosInstance(receiver)) isAxios = true;
      }
      if (!isAxios && !isAxiosReceiver(receiverText)) return;

      // Extract URL from first argument.
      const args = node.getArguments();
      if (args.length === 0) return;

      // Single resolution path shared with framework-fetch (#188).
      // Handles every URL shape: literals, no-substitution templates,
      // template expressions, binary `+` concatenation, identifier-bound
      // constants, and `Module.CONST` access. Returns dynamic when
      // nothing static is recoverable.
      let { urlLiteral, egressConfidence, templateSpanCount, templateSegmentCount, templateParts } =
        resolveCallerUrl(args[0] as Expression);

      // Compose baseURL when present (already resolved above).
      if (baseURL) {
        ({ urlLiteral, templateParts } = composeBaseUrl(
          baseURL,
          urlLiteral,
          templateParts,
        ));
      }

      if (egressConfidence !== 'exact') {
        recordConfidenceDecision('axios call egress not statically resolvable', {
          'axios.egress': egressConfidence,
          'axios.url': urlLiteral ?? '<null>',
          'axios.method': httpMethod,
          'call.sourceLine': node.getStartLineNumber(),
        });
      }

      const caller: ClientSideAPICaller = {
        nodeType: 'ClientSideAPICaller',
        id: idFor.clientSideAPICaller({
          sourceFileId: ctx.sourceFile.id,
          sourceLine: node.getStartLineNumber(),
          urlLiteral,
        }),
        functionId: ctx.enclosingFunction.id,
        sourceFileId: ctx.sourceFile.id,
        sourceLine: node.getStartLineNumber(),
        httpMethod,
        urlLiteral,
        egressConfidence,
        templateSpanCount,
        templateSegmentCount,
        ...(templateParts ? { templateParts } : {}),
        framework: 'axios',
        repository: ctx.sourceFile.repository,
        ...(urlLiteral ? (() => { const ext = detectExternalUrl(urlLiteral); return ext.isExternal ? { isExternal: true, externalHost: ext.host } : {}; })() : {}),
        evidence: buildEvidence(node, ctx.sourceFile.filePath,
          egressConfidence === 'exact' ? 'exact' : 'heuristic'),
      };
      ctx.emitNode(caller);
      ctx.emitEdge({
        edgeType: 'MAKES_REQUEST',
        from: ctx.enclosingFunction.id,
        to: caller.id,
      });
    },
  };
}

function isAxiosReceiver(text: string): boolean {
  const stripped = text.replace(/^this\./, '');
  // Direct match on known names.
  if (AXIOS_RECEIVERS.has(stripped)) return true;
  // Heuristic: any name containing 'api', 'axios', 'http', 'backend'.
  const lower = stripped.toLowerCase();
  if (lower.includes('api') || lower.includes('axios') ||
      lower.includes('http') || lower.includes('backend')) return true;
  return false;
}

/**
 * Given an `Identifier` used as the receiver of a method call
 * (`api.get(...)`), resolve its declaration and check whether its
 * initializer is `axios.create({ baseURL: '...' })`. Returns the
 * literal `baseURL` string when found, otherwise null.
 *
 * Handles three cases:
 *   1. Same-file `const api = axios.create({ baseURL: ... })`
 *   2. Imported `import { api } from './clients'` — symbol resolves
 *      through the alias to the original VariableDeclaration.
 *   3. baseURL value itself is an identifier — `resolveToString`
 *      follows it to the underlying literal (`const BASE = '/v3';`).
 *
 * Returns null for:
 *   - Non-`axios.create()` initializers
 *   - `axios.create()` without a baseURL property
 *   - baseURL whose value resolves to something non-string-like
 */
/**
 * Returns true when `identifier` resolves to a VariableDeclaration
 * whose initializer is `axios.create(...)`, regardless of whether
 * there's a baseURL on the create call. Used by the visitor to
 * recognize axios instances bound to arbitrarily-named identifiers
 * (e.g. `const sessioned = axios.create({ withCredentials: true })`).
 */
function isReceiverAnAxiosInstance(identifier: Node): boolean {
  if (!Node.isIdentifier(identifier)) return false;
  const symbol = identifier.getSymbol();
  if (!symbol) return false;
  const aliased = symbol.getAliasedSymbol?.() ?? null;
  const decls = (aliased ?? symbol).getDeclarations();
  for (const decl of decls) {
    if (!Node.isVariableDeclaration(decl)) continue;
    const init = decl.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    if (isAxiosCreateCall(init)) return true;
  }
  return false;
}

function resolveAxiosInstanceBaseURL(identifier: Node): string | null {
  if (!Node.isIdentifier(identifier)) return null;
  const symbol = identifier.getSymbol();
  if (!symbol) return null;
  // Follow alias (import) through to the original declaration.
  const aliased = symbol.getAliasedSymbol?.() ?? null;
  const decls = (aliased ?? symbol).getDeclarations();
  for (const decl of decls) {
    if (!Node.isVariableDeclaration(decl)) continue;
    const init = decl.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    if (!isAxiosCreateCall(init)) continue;
    const baseURL = readBaseURLFromCreateCall(init);
    if (baseURL !== null) return baseURL;
  }
  return null;
}

/**
 * Match `axios.create(...)` — the callee is a property access whose
 * receiver is the identifier `axios` and whose property name is
 * `create`. Renamed imports (`import { default as A } from 'axios'`)
 * are intentionally NOT followed; they're rare in practice and
 * adding the symbol resolution here costs more than the recall.
 */
function isAxiosCreateCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  if (callee.getNameNode().getText() !== 'create') return false;
  const recv = callee.getExpression();
  if (!Node.isIdentifier(recv)) return false;
  return recv.getText() === 'axios';
}

/**
 * Read the `baseURL` property off the first argument of an
 * `axios.create(...)` call. The arg must be an object literal; the
 * baseURL value may be a string literal OR an identifier we can
 * resolve via `resolveToString` (so `const BASE = '...'` works).
 *
 * Returns the literal baseURL string, or null if absent / not
 * statically recoverable.
 */
function readBaseURLFromCreateCall(call: CallExpression): string | null {
  const args = call.getArguments();
  if (args.length === 0) return null;
  const cfg = args[0];
  if (!cfg || !Node.isObjectLiteralExpression(cfg)) return null;
  for (const prop of cfg.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const name = prop.getNameNode();
    if (!Node.isIdentifier(name) || name.getText() !== 'baseURL') continue;
    const value = prop.getInitializer();
    if (!value) return null;
    if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
      return value.getLiteralValue();
    }
    // Identifier / other expression — try the shared constant resolver.
    const resolved = resolveToString(value);
    return resolved;
  }
  return null;
}

/**
 * Compose a baseURL with a per-call URL, returning the new urlLiteral
 * and a `templateParts` array that the stitcher's reconstruction
 * fast-path can consume.
 *
 *   composeBaseUrl('/api/v1',  '/users',      null)
 *     → urlLiteral: '/api/v1/users', templateParts: null
 *
 *   composeBaseUrl('/api/v1',  '/users/:p0',  ['/users/', ''])
 *     → urlLiteral: '/api/v1/users/:p0', templateParts: ['/api/v1/users/', '']
 *
 *   composeBaseUrl('https://api.example.com/', '/v2/x', null)
 *     → urlLiteral: 'https://api.example.com/v2/x', templateParts: null
 *
 *   composeBaseUrl('/api/v1', null, null)
 *     → urlLiteral: null (no path → caller stays as-is)
 *
 * Both inputs are slash-normalized so duplicate slashes can't
 * appear in the joined output.
 */
function composeBaseUrl(
  baseURL: string,
  urlLiteral: string | null,
  templateParts: readonly string[] | null,
): { urlLiteral: string | null; templateParts: string[] | null } {
  if (urlLiteral === null) {
    // Caller URL is dynamic. We have nothing to compose; preserve
    // the original urlLiteral=null so the caller remains marked
    // dynamic by the visitor.
    return { urlLiteral: null, templateParts: templateParts ? [...templateParts] : null };
  }
  const composed = joinUrlSegments(baseURL, urlLiteral);
  if (!templateParts || templateParts.length === 0) {
    return { urlLiteral: composed, templateParts: null };
  }
  // For template URLs: only the FIRST part of templateParts holds the
  // pre-placeholder prefix (the static head). Prepend baseURL there.
  const head = templateParts[0] ?? '';
  const newHead = joinUrlSegments(baseURL, head);
  return {
    urlLiteral: composed,
    templateParts: [newHead, ...templateParts.slice(1)],
  };
}

/**
 * Join two URL fragments, collapsing duplicate slashes at the
 * boundary. Handles the four shape combinations:
 *   ('/a', '/b')   → '/a/b'
 *   ('/a/', '/b')  → '/a/b'
 *   ('/a/', 'b')   → '/a/b'
 *   ('/a',  'b')   → '/a/b'
 *   ('',    '/b')  → '/b'
 *   ('/a',  '')    → '/a'
 *
 * Special case: an empty `right` returns `left` unchanged (matters
 * for the templateParts case where `templateParts[0]` can be `''`
 * when the template starts with an interpolation like `${x}/users`).
 */
function joinUrlSegments(left: string, right: string): string {
  if (left === '') return right;
  if (right === '') return left;
  const trimmedLeft = left.replace(/\/+$/, '');
  const trimmedRight = right.replace(/^\/+/, '');
  return `${trimmedLeft}/${trimmedRight}`;
}
