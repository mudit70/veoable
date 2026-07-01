import { Node } from 'ts-morph';
import { idFor, type ClientSideAPICaller } from '@adorable/schema';
import { type TsFrameworkVisitor, buildEvidence } from '@adorable/lang-ts';

/**
 * tRPC client proxy-call visitor (#551).
 *
 * Recognises the typed proxy-client call shape:
 *
 *   trpc.users.create.useMutation()
 *   trpc.users.list.useQuery({...})
 *   client.users.get.query(input)
 *   client.users.create.mutate(input)
 *   await trpc.posts.byId.query({ id })
 *
 * Per recognized call site, emits a `ClientSideAPICaller` with
 * `urlLiteral: '/trpc/<procedure.path>'` so the flow-stitcher can
 * match it to the server endpoint emitted by `framework-trpc`. The
 * HTTP method is inferred from the terminating method name:
 *
 *   useMutation, mutate          → POST
 *   useQuery, useInfiniteQuery,  → GET
 *   useSuspenseQuery, query
 *   useSubscription, subscribe   → WS
 *
 * Per-file import gate: at least one import from one of the
 * supported `@trpc/*` packages, so a project-local
 * `client.users.create.useMutation` from another library doesn't
 * false-fire.
 */

interface HookSpec {
  readonly httpMethod: string;
}

const HOOK_TO_METHOD: ReadonlyMap<string, HookSpec> = new Map([
  // React Query–style hooks (from @trpc/react-query)
  ['useQuery', { httpMethod: 'GET' }],
  ['useInfiniteQuery', { httpMethod: 'GET' }],
  ['useSuspenseQuery', { httpMethod: 'GET' }],
  ['useSuspenseInfiniteQuery', { httpMethod: 'GET' }],
  ['useMutation', { httpMethod: 'POST' }],
  ['useSubscription', { httpMethod: 'WS' }],
  // Vanilla client (from @trpc/client) — used outside React
  ['query', { httpMethod: 'GET' }],
  ['mutate', { httpMethod: 'POST' }],
  ['subscribe', { httpMethod: 'WS' }],
]);

/**
 * Procedure paths require AT LEAST this many path segments between
 * the client root identifier and the terminating hook. `client.list.
 * useMutation()` is the flat-router minimum (1 segment); bare
 * `client.useMutation()` is not a tRPC proxy call and is skipped.
 */
const MIN_PATH_SEGMENTS = 1;

/**
 * Per-file gate: the file must import SOMETHING whose specifier
 * mentions `trpc`. Catches direct `@trpc/*` imports AND project-local
 * re-exports (`./trpc`, `../trpc-client`, `../api/trpc`, etc.). The
 * substring check is permissive — a project that has a non-tRPC
 * package whose name contains `trpc` would match too — but
 * empirically this drops false-positives from `.query()` / `.mutate()`
 * collisions in projects that mix tRPC with knex / mongoose / Apollo
 * / formik (each of which exposes the same vocabulary on its own
 * unrelated proxies).
 */
const TRPC_SPECIFIER_RE = /trpc/i;

export function createTrpcClientVisitor(): TsFrameworkVisitor {
  // Per-file cache so we resolve imports once per file. The cache
  // lives for the lifetime of this visitor closure, not per
  // extractFile call — keyed by absolute path so reuse across
  // files in the same project is safe and the (file → boolean)
  // map grows linearly with the file count.
  const fileGate = new Map<string, boolean>();

  const fileMentionsTrpc = (node: Node): boolean => {
    const sf = node.getSourceFile();
    const filePath = sf.getFilePath();
    const cached = fileGate.get(filePath);
    if (cached !== undefined) return cached;
    const has = sf.getImportDeclarations().some((d) =>
      TRPC_SPECIFIER_RE.test(d.getModuleSpecifierValue()),
    );
    fileGate.set(filePath, has);
    return has;
  };

  return {
    language: 'ts',

    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!ctx.enclosingFunction) return;
      // The per-file gate drops false positives like
      // `knex.users.query()` or `formik.values.user.mutate()` in
      // multi-stack projects that depend on @trpc/* at the project
      // level (and would otherwise pass the plugin's appliesTo).
      if (!fileMentionsTrpc(node)) return;

      // Expect callee shape: `<root>.<seg1>.<seg2>.<hookName>`
      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      const hookName = callee.getNameNode().getText();
      const spec = HOOK_TO_METHOD.get(hookName);
      if (!spec) return;

      // Walk the chain leftward, collecting names. The leftmost
      // identifier is the client root; everything between is the
      // procedure path.
      const segments: string[] = [];
      let current: Node = callee.getExpression();
      while (Node.isPropertyAccessExpression(current)) {
        segments.unshift(current.getNameNode().getText());
        current = current.getExpression();
      }
      if (!Node.isIdentifier(current)) return; // Root must be a plain identifier.
      if (segments.length < MIN_PATH_SEGMENTS) return;

      const procedurePath = segments.join('.');
      const urlLiteral = `/trpc/${procedurePath}`;
      const evidence = buildEvidence(node, ctx.sourceFile.filePath);

      const caller: ClientSideAPICaller = {
        nodeType: 'ClientSideAPICaller',
        id: idFor.clientSideAPICaller({
          sourceFileId: ctx.sourceFile.id,
          sourceLine: evidence.lineStart,
          urlLiteral,
        }),
        functionId: ctx.enclosingFunction.id,
        sourceFileId: ctx.sourceFile.id,
        sourceLine: evidence.lineStart,
        httpMethod: spec.httpMethod,
        urlLiteral,
        // `pattern` rather than `exact` because the visitor uses a
        // shape-only match (`<root>.<seg+>.<hook>()`) — it doesn't
        // type-check that the root identifier is genuinely a tRPC
        // proxy. The per-file gate filters most false positives but
        // can't rule out a project-local non-trpc proxy in a file
        // that ALSO imports something from a trpc-flavored module.
        egressConfidence: 'pattern',
        framework: 'trpc-client',
        repository: ctx.sourceFile.repository,
        evidence,
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
