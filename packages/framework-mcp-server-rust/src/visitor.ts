import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@veoable/schema';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';

/**
 * Rust MCP server visitor (#537).
 *
 * One emit per `#[tool(...)]`-attributed method inside an impl block:
 *
 *     #[tool(description = "Increment the counter")]
 *     fn increment(&self) -> Result<CallToolResult, McpError> { … }
 *
 *     #[tool(name = "decrement_v2", description = "...")]
 *     fn decrement(&self) -> Result<CallToolResult, McpError> { … }
 *
 * Tool name defaults to the method name. When the attribute carries
 * `name = "..."`, that overrides — matches rmcp / mcp-rs behavior.
 *
 * Emit shape:
 *   - httpMethod: 'TOOL'
 *   - routePattern: 'mcp:<tool-name>'
 *   - framework: 'mcp-server-rust'
 *   - handlerFunctionId: id of the `<ImplType>.<method>`
 *     FunctionDefinition, computed the same way `framework-tonic`
 *     does it so the endpoint resolves to the existing handler node.
 *
 * Conservative v1 limits:
 *   - Only the `#[tool]` and `#[tool(...)]` attribute forms — the
 *     builder-style `Server::new().tool("name", handler)` registration
 *     is not detected (no widely-used OSS fixture today).
 *   - `#[resource]` / `#[prompt]` are out of scope for v1 (same
 *     mechanical shape; extendable when a fixture lands).
 *   - The attribute name is matched textually as `tool`. A code base
 *     that defines its own `#[tool]` attribute proc macro for a
 *     non-MCP purpose would false-positive — bounded by the project-
 *     level Cargo-crate gate in MCPServerRustPlugin.appliesTo.
 */
export function createMcpServerRustVisitor(): RustFrameworkVisitor {
  return {
    language: 'rust',
    onNode(ctx, node) {
      // We anchor on the impl block and iterate its function items.
      // This mirrors framework-tonic's structure and gives us the
      // `<ImplType>` context needed to compute handler ids that line
      // up with lang-rust's two-pass impl walker.
      if (node.type !== 'impl_item') return;

      const implType = extractImplType(node);
      if (!implType) return;

      const body = node.childForFieldName('body');
      if (!body) return;

      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (!child || child.type !== 'function_item') continue;

        const toolAttr = findToolAttribute(child);
        if (!toolAttr) continue;

        const methodNameNode = child.childForFieldName('name');
        const methodName = methodNameNode?.text;
        if (!methodName) continue;

        const toolName = readNameFromAttribute(toolAttr) ?? methodName;
        const methodLine = child.startPosition.row + 1;
        const routePattern = `mcp:${toolName}`;

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
            httpMethod: 'TOOL',
            routePattern,
            filePath: evidence.filePath,
            lineStart: evidence.lineStart,
          }),
          httpMethod: 'TOOL',
          routePattern,
          handlerFunctionId,
          framework: 'mcp-server-rust',
          repository: ctx.sourceFile.repository,
          evidence,
        };
        ctx.emitNode(endpoint);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tree-sitter shape helpers (parallel to framework-tonic's helpers)
// ─────────────────────────────────────────────────────────────────────

/**
 * Walk the previousNamedSibling chain of a function_item looking for
 * an `attribute_item` whose path ends with `tool`. Stops at the
 * first non-attribute sibling — attributes immediately precede their
 * target item in tree-sitter-rust's grammar.
 *
 * Accepts:
 *   #[tool]
 *   #[tool(...)]
 *   #[rmcp::tool(...)]        (scoped path — last segment must be `tool`)
 *   #[mcp_sdk::tool(...)]
 *
 * Returns the attribute node (so the caller can read its arg text)
 * or null when no matching attribute is found.
 */
function findToolAttribute(fnNode: SyntaxNode): SyntaxNode | null {
  let sibling = fnNode.previousNamedSibling;
  while (sibling) {
    if (sibling.type !== 'attribute_item' && sibling.type !== 'inner_attribute_item') break;
    if (attributeIsTool(sibling)) return sibling;
    sibling = sibling.previousNamedSibling;
  }
  return null;
}

/**
 * Match `#[tool]` / `#[tool(...)]` / `#[crate::tool(...)]`. The
 * attribute's path is the last `::`-separated segment of the leading
 * identifier(s). We do this textually to keep the helper standalone;
 * the project-level Cargo gate prevents a false-positive `tool` from
 * an unrelated crate.
 */
function attributeIsTool(attrNode: SyntaxNode): boolean {
  // The attribute_item text is `#[<inside>]`. Strip the wrapper to
  // get `<inside>`.
  const text = attrNode.text.trim();
  if (!text.startsWith('#[') || !text.endsWith(']')) return false;
  const inside = text.slice(2, -1).trim();
  // Take the leading identifier path (everything before `(` or end).
  const parenIdx = inside.indexOf('(');
  const path = (parenIdx >= 0 ? inside.slice(0, parenIdx) : inside).trim();
  const lastSegment = path.includes('::') ? path.slice(path.lastIndexOf('::') + 2) : path;
  return /^tool$/.test(lastSegment.trim());
}

/**
 * If the `#[tool(...)]` attribute carries a `name = "..."` argument,
 * return that literal. Otherwise return null and the caller falls
 * back to the method name.
 */
function readNameFromAttribute(attrNode: SyntaxNode): string | null {
  const text = attrNode.text;
  // `name` may be quoted as `"..."` or `'...'`. We accept either —
  // the SDK convention is double quotes; cover single for safety.
  const m = /\bname\s*=\s*(["'])((?:\\.|(?!\1).)*)\1/.exec(text);
  return m ? m[2] : null;
}

/**
 * Extract the `<Struct>` from `impl <Struct> { ... }` (inherent impl,
 * the dominant MCP server shape) or from `impl <Trait> for <Struct>`
 * (trait impl, less common for tool registration but accepted).
 *
 * Stays byte-for-byte aligned with lang-rust's `extractImplTypeName`
 * (`packages/lang-rust/src/extract-source-file.ts`) because the
 * handler id we compute downstream is keyed on exactly that string.
 * Mirrors `framework-tonic`'s implementation.
 */
function extractImplType(implNode: SyntaxNode): string | null {
  // Inherent impl (`impl Counter { ... }`): there is no `for`
  // keyword; the FIRST type-shaped child is the impl type.
  // Trait impl (`impl ToolRouter for Counter { ... }`): we want the
  // type AFTER the `for` keyword.
  let hasFor = false;
  let firstType: SyntaxNode | null = null;
  let typeAfterFor: SyntaxNode | null = null;
  for (let i = 0; i < implNode.childCount; i++) {
    const child = implNode.child(i);
    if (!child) continue;
    if (child.type === 'for') {
      hasFor = true;
      continue;
    }
    if (isTypeNode(child.type)) {
      if (!hasFor && firstType === null) firstType = child;
      if (hasFor && typeAfterFor === null) typeAfterFor = child;
    }
  }
  const pick = hasFor ? typeAfterFor : firstType;
  if (!pick) return null;
  if (pick.type === 'generic_type') {
    const inner = pick.children.find((c) => c.type === 'type_identifier');
    return inner?.text ?? pick.text;
  }
  return pick.text;
}

function isTypeNode(type: string): boolean {
  return type === 'type_identifier'
    || type === 'scoped_type_identifier'
    || type === 'generic_type';
}
