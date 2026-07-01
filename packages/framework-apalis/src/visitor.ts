import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type ClientSideAPICaller } from '@adorable/schema';
import { hasCrateImport, type RustFrameworkVisitor, type RustVisitContext } from '@adorable/lang-rust';

/**
 * apalis visitor — producer + consumer pairs.
 *
 * Producer side (→ ClientSideAPICaller, httpMethod='JOB'):
 *   storage.push(SendEmailJob { to: "x".into() }).await?
 *
 *   Heuristic: any `<recv>.push(<expr>)` call where `<expr>` is a
 *   struct literal (`struct_expression`). routePattern is the
 *   last segment of the struct's path identifier.
 *
 * Consumer side (→ APIEndpoint, httpMethod='JOB'):
 *   WorkerBuilder::new("send-email")
 *       .with_storage(storage.clone())
 *       .build_fn(send_email)
 *
 *   Strategy:
 *     1. Per-file scan for `async fn send_email(job: SendEmailJob)`
 *        builds a map `<fn-name> → <struct-type>`.
 *     2. On `build_fn(<fn-name>)`, look up the fn's first param
 *        type → routePattern is the struct type. So producer and
 *        consumer agree on the SAME struct-type identifier.
 *
 * Per-file gate: file must `use apalis` (any path).
 *
 * Conservative v1: producers that push a bound variable (`storage
 * .push(job)`) don't resolve the type — no emit. Real-world code
 * frequently uses struct literals directly at push sites, so the
 * gap is small in practice.
 */

export function createApalisVisitor(): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const fnTypesByFile = new Map<string, Map<string, string>>();

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const value = hasCrateImport(root, 'apalis');
    importsByFile.set(filePath, value);
    return value;
  };

  const getFnTypes = (filePath: string, root: SyntaxNode): Map<string, string> => {
    let m = fnTypesByFile.get(filePath);
    if (!m) {
      m = scanFileForJobFnTypes(root);
      fnTypesByFile.set(filePath, m);
    }
    return m;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'field_expression') return;
      const field = fn.childForFieldName('field');
      const operand = fn.childForFieldName('value');
      if (!field || !operand) return;

      const methodName = field.text;
      const args = node.childForFieldName('arguments');

      // ── Producer: <storage>.push(<struct-expr>) ─────────
      if (methodName === 'push' || methodName === 'push_with') {
        if (!args) return;
        const firstArg = firstNonPunctChild(args);
        if (!firstArg) return;
        const structName = extractStructName(firstArg);
        if (!structName) return;
        emitCaller(ctx, node, structName);
        return;
      }

      // ── Consumer: WorkerBuilder::...build_fn(<fn-name>) ──
      if (methodName === 'build_fn') {
        if (!args) return;
        const fnArg = firstNonPunctChild(args);
        if (!fnArg || fnArg.type !== 'identifier') return;
        const fnTypes = getFnTypes(ctx.sourceFile.filePath, node.tree.rootNode);
        const structName = fnTypes.get(fnArg.text);
        if (!structName) return;
        emitEndpoint(ctx, node, structName, fnArg.text);
        return;
      }
    },
  };
}

function emitCaller(
  ctx: RustVisitContext,
  callNode: SyntaxNode,
  structName: string,
): void {
  if (!ctx.enclosingFunction) return;
  const sourceLine = callNode.startPosition.row + 1;
  const routePattern = `apalis:${structName}`;
  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine,
      urlLiteral: routePattern,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine,
    httpMethod: 'JOB',
    urlLiteral: routePattern,
    egressConfidence: 'exact',
    framework: 'apalis',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: sourceLine,
      lineEnd: callNode.endPosition.row + 1,
      snippet: callNode.text.slice(0, 200),
      confidence: 'exact',
    },
  };
  ctx.emitNode(caller);
  ctx.emitEdge({
    edgeType: 'MAKES_REQUEST',
    from: ctx.enclosingFunction.id,
    to: caller.id,
  });
}

function emitEndpoint(
  ctx: RustVisitContext,
  evidenceNode: SyntaxNode,
  structName: string,
  handlerName: string,
): void {
  const evidenceLine = evidenceNode.startPosition.row + 1;
  const routePattern = `apalis:${structName}`;
  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod: 'JOB',
      routePattern,
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
    }),
    httpMethod: 'JOB',
    routePattern,
    handlerFunctionId: null,
    framework: 'apalis',
    repository: ctx.sourceFile.repository,
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: evidenceLine,
      lineEnd: evidenceNode.endPosition.row + 1,
      snippet: evidenceNode.text.slice(0, 200),
      confidence: 'exact',
    },
  };
  ctx.emitNode(endpoint);
  void handlerName;
}

/**
 * Walk every `async fn <name>(<param>: <Type>, ...)` in the file
 * and record a `<name> → <Type-last-segment>` mapping. Synchronous
 * functions are included too (apalis allows them).
 */
function scanFileForJobFnTypes(rootNode: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'function_item') {
      const name = n.childForFieldName('name');
      const params = n.childForFieldName('parameters');
      if (name && params) {
        const firstParamType = extractFirstParamType(params);
        if (firstParamType) {
          const last = lastPathSegment(firstParamType);
          out.set(name.text, last);
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(rootNode);
  return out;
}

/**
 * Walk the function's parameters and return the first param whose
 * type ISN'T a known apalis extractor (`Data<...>`, `State<...>`,
 * `Extension<...>`, `WorkerCtx`, `WorkerId`). The job-type
 * parameter is usually a plain struct (no generic angle-bracket
 * wrapping) — by skipping recognized extractors we avoid mapping
 * `fn h(state: Data<AppState>, job: SendEmailJob)` to a phantom
 * `Data` "table" that no producer would ever stitch to.
 */
function extractFirstParamType(params: SyntaxNode): string | null {
  for (let i = 0; i < params.childCount; i++) {
    const c = params.child(i);
    if (!c) continue;
    if (c.type !== 'parameter') continue;
    const type = c.childForFieldName('type');
    if (!type) continue;
    if (isExtractorType(type.text)) continue;
    return type.text;
  }
  return null;
}

const EXTRACTOR_RE = /^(?:&?(?:mut\s+)?)?(?:Data|State|Extension|Extractor|WorkerCtx|WorkerId|Context)\b/;

function isExtractorType(text: string): boolean {
  return EXTRACTOR_RE.test(text);
}

/**
 * Extract the struct identifier from an expression like:
 *   `SendEmailJob { to: "x".into() }`        → 'SendEmailJob'
 *   `crate::jobs::SendEmailJob { ... }`     → 'SendEmailJob'
 *   `&SendEmailJob { ... }`                  → 'SendEmailJob'
 */
function extractStructName(expr: SyntaxNode): string | null {
  let n: SyntaxNode = expr;
  if (n.type === 'reference_expression') {
    const v = n.childForFieldName('value');
    if (v) n = v;
  }
  if (n.type !== 'struct_expression') return null;
  // struct_expression has a `name` field whose type is
  // type_identifier or scoped_type_identifier.
  const nameNode = n.childForFieldName('name');
  if (!nameNode) return null;
  return lastPathSegment(nameNode.text);
}

function firstNonPunctChild(args: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    return c;
  }
  return null;
}

function lastPathSegment(text: string): string {
  const i = text.lastIndexOf('::');
  return i >= 0 ? text.slice(i + 2) : text;
}
