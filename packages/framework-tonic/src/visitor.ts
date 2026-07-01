import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@veoable/schema';
import {
  isImportedFromCrate,
  scanCrateImports,
  type CrateImports,
  type RustFrameworkVisitor,
} from '@veoable/lang-rust';

/**
 * tonic visitor (#439 third slice).
 *
 * One emit per async method inside a gRPC service impl block.
 *
 * Shape we detect:
 *
 *   #[tonic::async_trait]
 *   impl <Trait> for <Struct> {
 *       async fn <method_name>(&self, ...) -> Result<...> { ... }
 *   }
 *
 * APIEndpoint shape per method:
 *   - httpMethod: 'GRPC'
 *   - routePattern: 'grpc:<Trait>/<method_name>'
 *   - framework: 'tonic'
 *   - handlerFunctionId: id of `<Struct>.<method>` FunctionDefinition
 *     (lang-rust's two-pass impl walker registers methods under
 *     `<ImplType>.<methodName>`; we compute the same id so the
 *     endpoint resolves to the existing handler node).
 *
 * Conservative v1 limits (each tracked as follow-up):
 *   - Only the fully-scoped `#[tonic::async_trait]` attribute form.
 *     Bare `#[async_trait]` after `use tonic::async_trait;` waits on
 *     the per-crate import-scanner extraction tracked in #444.
 *   - Trait name uses the local Rust identifier; the actual gRPC
 *     service name comes from the .proto package + service, which
 *     we don't read. Codebases that name the trait differently from
 *     the proto service get an incorrect routePattern. A follow-up
 *     can read tonic-build's generated `*.rs` to recover the real
 *     name.
 *   - Streaming methods (server/client/bidirectional) carry the
 *     same routePattern shape; v1 doesn't distinguish them.
 */
export function createTonicVisitor(): RustFrameworkVisitor {
  // Per-file index of `use tonic::*` imports, populated lazily on
  // first node dispatch per file. Same pattern framework-diesel uses.
  const importsByFile = new Map<string, CrateImports>();
  const getImports = (filePath: string, root: SyntaxNode): CrateImports => {
    let imp = importsByFile.get(filePath);
    if (!imp) {
      imp = scanCrateImports(root, 'tonic');
      importsByFile.set(filePath, imp);
    }
    return imp;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'impl_item') return;
      const imp = getImports(ctx.sourceFile.filePath, node.tree.rootNode);
      if (!hasTonicAsyncTraitAttribute(node, imp)) return;

      const traitName = extractTraitName(node);
      if (!traitName) return;
      const implType = extractImplType(node);
      if (!implType) return;

      const body = node.childForFieldName('body');
      if (!body) return;

      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (!child || child.type !== 'function_item') continue;
        if (!isAsyncFunction(child)) continue;

        const methodNameNode = child.childForFieldName('name');
        const methodName = methodNameNode?.text;
        if (!methodName) continue;

        const methodLine = child.startPosition.row + 1;
        const routePattern = `grpc:${traitName}/${methodName}`;

        const handlerFunctionId = idFor.functionDefinition({
          sourceFileId: ctx.sourceFile.id,
          name: `${implType}.${methodName}`,
          sourceLine: methodLine,
        });

        const evidence = {
          filePath: ctx.sourceFile.filePath,
          lineStart: methodLine,
          lineEnd: child.endPosition.row + 1,
          snippet: child.text.length <= 500 ? child.text : child.text.slice(0, 499) + '…',
          confidence: 'exact' as const,
        };

        const endpoint: APIEndpoint = {
          nodeType: 'APIEndpoint',
          id: idFor.apiEndpoint({
            repository: ctx.sourceFile.repository,
            httpMethod: 'GRPC',
            routePattern,
            filePath: evidence.filePath,
            lineStart: evidence.lineStart,
          }),
          httpMethod: 'GRPC',
          routePattern,
          handlerFunctionId,
          framework: 'tonic',
          repository: ctx.sourceFile.repository,
          evidence,
        };
        ctx.emitNode(endpoint);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tree-sitter shape helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Walk the previousNamedSibling chain looking for an `attribute_item`
 * whose text contains `tonic::async_trait`. Stops at the first
 * non-attribute sibling — attributes immediately precede their target
 * item in tree-sitter-rust's grammar.
 *
 * Known v1 false-negative: a doc comment between the attribute and
 * the impl (`#[tonic::async_trait]\n/// docs\nimpl Greeter ...`)
 * breaks the walk because `line_comment` isn't in the
 * attribute-item set. Rare in practice — codebases overwhelmingly
 * put doc comments on the trait/struct, not between an attribute
 * and the impl it applies to. A follow-up can teach the loop to
 * skip past comment nodes.
 */
function hasTonicAsyncTraitAttribute(implNode: SyntaxNode, imp: CrateImports): boolean {
  let sibling = implNode.previousNamedSibling;
  while (sibling) {
    if (sibling.type !== 'attribute_item' && sibling.type !== 'inner_attribute_item') break;
    const text = sibling.text;
    // Fully scoped — `#[tonic::async_trait]`.
    if (text.includes('tonic::async_trait')) return true;
    // Bare — `#[async_trait]` (optionally with the `?Send` arg, e.g.
    // `#[async_trait(?Send)]` — documented and used for non-Send
    // futures) when `async_trait` is imported from tonic in this file.
    // The import gate keeps a same-named bare attribute from a
    // non-tonic crate (e.g. async-trait crate directly) from
    // false-positive-ing. `\b` after the name prevents
    // `#[async_trait_helper]` from matching.
    if (/^#\[\s*async_trait\b[^\]]*\]$/.test(text.trim()) && isImportedFromCrate(imp, 'async_trait')) {
      return true;
    }
    sibling = sibling.previousNamedSibling;
  }
  return false;
}

/**
 * Extract the trait name from `impl <Trait> for <Struct>`. Returns
 * the LAST segment of a scoped trait path so
 * `impl greeter_server::Greeter for X` resolves to `Greeter` — that's
 * what the canonical tonic-build output uses. Returns null when the
 * impl has no trait (`impl X { ... }` — those aren't gRPC services).
 */
function extractTraitName(implNode: SyntaxNode): string | null {
  let hasFor = false;
  let lastTypeBeforeFor: SyntaxNode | null = null;
  for (let i = 0; i < implNode.childCount; i++) {
    const child = implNode.child(i);
    if (!child) continue;
    if (child.type === 'for') {
      hasFor = true;
      continue;
    }
    if (!hasFor && isTypeNode(child.type)) {
      lastTypeBeforeFor = child;
    }
  }
  if (!hasFor || !lastTypeBeforeFor) return null;
  return lastPathSegment(lastTypeBeforeFor.text);
}

/**
 * Extract the `<Struct>` from `impl <Trait> for <Struct>`. MUST stay
 * byte-for-byte aligned with lang-rust's `extractImplTypeName`
 * (`packages/lang-rust/src/extract-source-file.ts`), because the
 * handler-id we compute downstream is keyed on exactly that string:
 *
 *   impl Trait for Generic<T>   → "Generic"
 *   impl Trait for foo::Bar     → "foo::Bar"   (scoped path PRESERVED)
 *   impl Trait for Bar          → "Bar"
 *
 * The previous version of this helper stripped scoped paths via
 * `lastPathSegment`. That broke `handlerFunctionId` resolution for
 * `impl SomeTrait for module::Server` style impls because lang-rust
 * registers the FunctionDefinition under `module::Server.<method>`
 * — endpoint and function would never join. See the fixture's
 * ScopedGreeter case for the regression test.
 */
function extractImplType(implNode: SyntaxNode): string | null {
  let hasFor = false;
  let typeAfterFor: SyntaxNode | null = null;
  for (let i = 0; i < implNode.childCount; i++) {
    const child = implNode.child(i);
    if (!child) continue;
    if (child.type === 'for') {
      hasFor = true;
      continue;
    }
    if (hasFor && isTypeNode(child.type)) {
      typeAfterFor = child;
      break;
    }
  }
  if (!typeAfterFor) return null;
  if (typeAfterFor.type === 'generic_type') {
    const inner = typeAfterFor.children.find((c) => c.type === 'type_identifier');
    return inner?.text ?? typeAfterFor.text;
  }
  return typeAfterFor.text;
}

function isTypeNode(type: string): boolean {
  return type === 'type_identifier'
    || type === 'scoped_type_identifier'
    || type === 'generic_type';
}

/** `foo::bar::Baz` → `Baz`; `Baz` → `Baz`. */
function lastPathSegment(text: string): string {
  const i = text.lastIndexOf('::');
  return i >= 0 ? text.slice(i + 2) : text;
}

function isAsyncFunction(fnNode: SyntaxNode): boolean {
  // tree-sitter-rust marks async via `function_modifiers` child
  // containing `async`. Lang-rust uses `hasAsyncModifier` internally;
  // we replicate the check rather than pull a private helper across.
  for (let i = 0; i < fnNode.childCount; i++) {
    const child = fnNode.child(i);
    if (!child) continue;
    if (child.type === 'function_modifiers') {
      for (let j = 0; j < child.childCount; j++) {
        const g = child.child(j);
        if (g && g.text === 'async') return true;
      }
    }
    if (child.type === 'async') return true;
  }
  return false;
}
