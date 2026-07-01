import { Node, type CallExpression, type Expression, type NewExpression } from 'ts-morph';
import { idFor, type ClientSideAPICaller } from '@veoable/schema';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  resolveToString,
} from '@veoable/lang-ts';

/**
 * RPC-client visitor (#408).
 *
 * For each `<recv>.sendRequest('Method', payload)` call:
 *   1. Resolve `<recv>` to its binding (Identifier or `this.<field>`
 *      chain).
 *   2. If the binding is initialised by `new <RpcClientCtor>({ url:
 *      '/api/x' })` for a recognised constructor, capture its baseUrl.
 *   3. Synthesize the request URL as `<baseUrl>?r=<methodName>`.
 *   4. Emit a `ClientSideAPICaller` with framework='rpc-client',
 *      httpMethod='POST', egressConfidence='exact'.
 *
 * Receiver-resolution covers:
 *   - Plain identifier: `const jade = new PostAPIClient({...}); jade.sendRequest(...)`.
 *   - This-field initialiser: `class API { jade = new PostAPIClient({...}); foo() { this.jade.sendRequest(...) } }`.
 *   - This-field constructor assignment: `this.jade = new PostAPIClient(...)`.
 *   - One-level nested chain: `this.api.jade.sendRequest(...)` where
 *     `this.api` is typed `API` and `API.jade = new PostAPIClient(...)`.
 */

const RPC_CLIENT_CTORS: ReadonlySet<string> = new Set([
  'PostAPIClient',
  'PostAPIBrowserClient',
  'PostAPI',
  'RpcClient',
  'RPCClient',
  'JsonRpcClient',
  'JSONRPCClient',
]);

/**
 * Method names that dispatch an RPC request. Conservative on purpose:
 * `sendRequest` is the PostAPIClient idiom, `send` / `call` cover the
 * close cousins. tRPC's `.query()` / `.mutate()` shape is structurally
 * different (chained-proxy access, no string method arg) and is out
 * of scope — a separate plugin or extension would be needed.
 */
const SEND_METHODS: ReadonlySet<string> = new Set(['sendRequest', 'send', 'call']);

/**
 * Query-param name used to encode the method in the URL. PostAPIClient
 * uses `?r=<method>`; this is the most common convention.
 */
const METHOD_PARAM_NAME = 'r';

export function createRpcClientVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!ctx.enclosingFunction) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      const methodName = callee.getNameNode().getText();
      if (!SEND_METHODS.has(methodName)) return;

      // First arg must be a string-literal method name.
      const args = node.getArguments();
      if (args.length === 0) return;
      const methodArg = args[0];
      const rpcMethod = resolveToString(methodArg);
      if (!rpcMethod) return;

      // Resolve the receiver to a constructor call.
      const receiver = callee.getExpression();
      const baseUrl = resolveReceiverBaseUrl(receiver);
      if (!baseUrl) return;

      const urlLiteral = synthesizeUrl(baseUrl, rpcMethod);

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
        httpMethod: 'POST',
        urlLiteral,
        egressConfidence: 'exact',
        templateSpanCount: null,
        templateSegmentCount: null,
        framework: 'rpc-client',
        repository: ctx.sourceFile.repository,
        evidence: buildEvidence(node, ctx.sourceFile.filePath, 'exact'),
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

/**
 * Walk the receiver back to a `new <RpcClientCtor>({ url: '...' })`
 * initialiser. Returns the base URL on success, or null.
 *
 * Supported shapes:
 *   - Identifier `client` → const client = new PostAPIClient({ url })
 *   - this.<field>        → class field initialiser `<field> = new PostAPIClient(...)`
 *                           OR constructor assignment `this.<field> = new PostAPIClient(...)`
 *   - this.<a>.<b>        → class field `<a>` typed as a class whose `<b>` is the constructor
 */
function resolveReceiverBaseUrl(receiver: Node): string | null {
  if (Node.isIdentifier(receiver)) {
    return baseUrlFromIdentifier(receiver);
  }
  if (Node.isPropertyAccessExpression(receiver)) {
    const left = receiver.getExpression();
    const fieldName = receiver.getNameNode().getText();
    // this.<field>
    if (Node.isThisExpression(left)) {
      const cls = receiver.getFirstAncestor(
        (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a),
      );
      if (cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) {
        return baseUrlFromClassField(cls, fieldName);
      }
    }
    // this.<a>.<b> — left is a PropertyAccessExpression on `this`.
    if (Node.isPropertyAccessExpression(left) && Node.isThisExpression(left.getExpression())) {
      const outerFieldName = left.getNameNode().getText();
      const cls = receiver.getFirstAncestor(
        (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a),
      );
      if (cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls))) {
        const outerClass = resolveClassFieldType(cls, outerFieldName);
        if (outerClass) return baseUrlFromClassField(outerClass, fieldName);
      }
    }
  }
  return null;
}

function baseUrlFromIdentifier(ident: Node): string | null {
  if (!Node.isIdentifier(ident)) return null;
  const sym = ident.getSymbol();
  if (!sym) return null;
  for (const decl of sym.getDeclarations()) {
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && Node.isNewExpression(init)) {
        const url = baseUrlFromNewExpression(init);
        if (url) return url;
      }
    }
  }
  return null;
}

function baseUrlFromClassField(
  cls: import('ts-morph').ClassDeclaration | import('ts-morph').ClassExpression,
  fieldName: string,
): string | null {
  // 1. Field initialiser: `<field> = new PostAPIClient({...})`.
  for (const prop of cls.getProperties()) {
    if (prop.getName() !== fieldName) continue;
    const init = prop.getInitializer();
    if (init && Node.isNewExpression(init)) {
      const url = baseUrlFromNewExpression(init);
      if (url) return url;
    }
  }
  // 2. Constructor body assignment: `this.<field> = new PostAPIClient({...})`.
  for (const ctor of cls.getConstructors()) {
    const body = ctor.getBody();
    if (!body) continue;
    let found: string | null = null;
    body.forEachDescendant((d, traversal) => {
      if (found) {
        traversal.stop();
        return;
      }
      if (!Node.isBinaryExpression(d)) return;
      if (d.getOperatorToken().getText() !== '=') return;
      const left = d.getLeft();
      if (!Node.isPropertyAccessExpression(left)) return;
      if (!Node.isThisExpression(left.getExpression())) return;
      if (left.getNameNode().getText() !== fieldName) return;
      const right = d.getRight();
      if (!Node.isNewExpression(right)) return;
      const url = baseUrlFromNewExpression(right);
      if (url) {
        found = url;
        traversal.stop();
      }
    });
    if (found) return found;
  }
  return null;
}

/**
 * For a chain like `this.api.jade.sendRequest(...)`, resolve `this.api`
 * to its class type so we can look up `.jade` on it. Walks the class
 * field's type annotation OR the field's initialiser
 * (`new APIClass()`) to find the producer ClassDeclaration.
 */
function resolveClassFieldType(
  cls: import('ts-morph').ClassDeclaration | import('ts-morph').ClassExpression,
  fieldName: string,
): import('ts-morph').ClassDeclaration | null {
  for (const prop of cls.getProperties()) {
    if (prop.getName() !== fieldName) continue;
    // Field initialiser is `new SomeClass(...)`.
    const init = prop.getInitializer();
    if (init && Node.isNewExpression(init)) {
      const ctor = init.getExpression();
      if (Node.isIdentifier(ctor)) {
        const cd = resolveIdentifierToClassDeclaration(ctor);
        if (cd) return cd;
      }
    }
    // Or a type annotation `<field>: SomeClass`.
    const typeNode = prop.getTypeNode();
    if (typeNode && Node.isTypeReference(typeNode)) {
      const tn = typeNode.getTypeName();
      if (Node.isIdentifier(tn)) {
        const cd = resolveIdentifierToClassDeclaration(tn);
        if (cd) return cd;
      }
    }
  }
  // Also check constructor parameter assignments to `this.<field>`.
  for (const ctor of cls.getConstructors()) {
    const body = ctor.getBody();
    if (!body) continue;
    let found: import('ts-morph').ClassDeclaration | null = null;
    body.forEachDescendant((d, traversal) => {
      if (found) {
        traversal.stop();
        return;
      }
      if (!Node.isBinaryExpression(d)) return;
      if (d.getOperatorToken().getText() !== '=') return;
      const left = d.getLeft();
      if (!Node.isPropertyAccessExpression(left)) return;
      if (!Node.isThisExpression(left.getExpression())) return;
      if (left.getNameNode().getText() !== fieldName) return;
      const right = d.getRight();
      if (Node.isNewExpression(right)) {
        const ctorExpr = right.getExpression();
        if (Node.isIdentifier(ctorExpr)) {
          const cd = resolveIdentifierToClassDeclaration(ctorExpr);
          if (cd) {
            found = cd;
            traversal.stop();
            return;
          }
        }
      }
    });
    if (found) return found;
  }
  return null;
}

/**
 * Resolve an identifier reference to its ClassDeclaration. Follows
 * cross-file ImportSpecifier / ImportClause to the producer module's
 * exported class. Returns null when the identifier resolves to
 * anything else (variable, function, interface, etc.).
 */
function resolveIdentifierToClassDeclaration(
  ident: Node,
): import('ts-morph').ClassDeclaration | null {
  if (!Node.isIdentifier(ident)) return null;
  const sym = ident.getSymbol();
  if (!sym) return null;
  for (const decl of sym.getDeclarations()) {
    if (Node.isClassDeclaration(decl)) return decl;
    // Cross-file: ImportSpecifier or ImportClause — follow to the
    // producer file's exported declaration.
    if (Node.isImportSpecifier(decl) || Node.isImportClause(decl)) {
      const impDecl = decl.getFirstAncestor((a) => Node.isImportDeclaration(a));
      if (!impDecl || !Node.isImportDeclaration(impDecl)) continue;
      const target = impDecl.getModuleSpecifierSourceFile();
      if (!target) continue;
      const exportName = Node.isImportSpecifier(decl) ? decl.getName() : 'default';
      const exported = target.getExportedDeclarations().get(exportName);
      if (!exported) continue;
      for (const e of exported) {
        if (Node.isClassDeclaration(e)) return e;
      }
    }
  }
  return null;
}

/**
 * Inspect `new SomeClient({ url: '...' })` and return the URL if the
 * constructor name is in the RPC_CLIENT_CTORS allowlist.
 */
function baseUrlFromNewExpression(expr: NewExpression): string | null {
  const ctor = expr.getExpression();
  if (!Node.isIdentifier(ctor)) return null;
  if (!RPC_CLIENT_CTORS.has(ctor.getText())) return null;
  const args = expr.getArguments();
  if (args.length === 0) return null;
  const first = args[0];
  if (!Node.isObjectLiteralExpression(first)) return null;
  // Try `url` then `baseUrl`.
  for (const key of ['url', 'baseUrl', 'baseURL']) {
    const prop = first.getProperty(key);
    if (!prop || !Node.isPropertyAssignment(prop)) continue;
    const init = prop.getInitializer();
    if (!init) continue;
    const resolved = resolveToString(init);
    if (resolved) return resolved;
  }
  return null;
}

function synthesizeUrl(baseUrl: string, methodName: string): string {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}${METHOD_PARAM_NAME}=${methodName}`;
}

// Suppress unused-import lint on Expression / CallExpression types
// kept for clarity of the visitor's argument shapes.
void (null as unknown as Expression | CallExpression);
