import * as fs from 'node:fs';
import * as path from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { recordConfidenceDecision } from '@adorable/observability';

/**
 * Build-tool proxy-config detection (#188 Cause 2 / Fix 3).
 *
 * Frontend SPAs commonly call `fetch('/api/projects/:id/...')` because
 * Vite or Webpack's dev server proxies `/api/*` to a separate backend.
 * The stitcher's segment-strict matcher otherwise can't resolve those
 * to the backend's `/projects/:id/...` route — they have a different
 * segment count.
 *
 * This module reads each repo's build-tool config files (currently
 * Vite; Webpack/Next.js/CRA/Angular are stubbed as follow-ups) and
 * extracts the proxy rules deterministically via AST. Rules are
 * applied at stitch time by `url-matcher.ts:matchCallerToEndpoints`.
 *
 * Detection is structural — no source-text regex on the config. When
 * a config shape is non-deterministic (e.g., the `rewrite` is a
 * dynamically-bound function), we record a `ConfidenceDecision`
 * event and skip the rule rather than guess.
 */

export interface ProxyRule {
  /** URL prefix the proxy intercepts, e.g. `'/api'`. */
  prefix: string;
  /**
   * `true` when the proxy's `rewrite` function strips `prefix` before
   * forwarding to upstream — the canonical Vite/webpack pattern of
   * `path.replace(/^\/api/, '')`. When true, the stitcher should
   * strip `prefix` from the caller URL when looking for matches.
   * When false, the upstream sees the full path and no transformation
   * is applied.
   */
  stripsPrefix: boolean;
  /**
   * Upstream URL the proxy forwards to (for repo-scoping when project
   * config maps `devUrl` → repo name). `null` when the config doesn't
   * declare an explicit target.
   */
  upstreamTarget: string | null;
  /** Source location for debugging / span events. */
  evidence: { filePath: string; lineStart: number };
  /** Source tool. Useful for diagnostics; not used in matching. */
  source: 'vite' | 'webpack' | 'next' | 'cra' | 'angular';
}

const VITE_CONFIG_NAMES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
];

/**
 * Discover proxy rules from a repo root.
 *
 * Scans for known build-tool config files and extracts each one's
 * proxy table. Returns an empty array when no recognized config is
 * present — callers should treat that as "no proxy rules to apply"
 * (the caller URLs go through the unchanged matcher path).
 */
export function discoverProxyRules(repoRoot: string): ProxyRule[] {
  const rules: ProxyRule[] = [];
  const absRoot = path.resolve(repoRoot);

  for (const name of VITE_CONFIG_NAMES) {
    const candidate = path.join(absRoot, name);
    if (fs.existsSync(candidate)) {
      rules.push(...extractViteProxyRules(candidate));
      // Vite uses one config file at most; stop after the first hit.
      break;
    }
  }

  // Webpack: webpack.config.{js,ts} → devServer.proxy. Future PR.
  // Next.js: next.config.{js,mjs} → rewrites(). Future PR.
  // CRA: package.json → "proxy" string. Future PR.
  // Angular: angular.json → architect.serve.options.proxyConfig. Future PR.

  return rules;
}

// ──────────────────────────────────────────────────────────────────────
// Vite — vite.config.ts
// ──────────────────────────────────────────────────────────────────────

function extractViteProxyRules(configPath: string): ProxyRule[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    // Vite configs are commonly `.js`/`.mjs`. Without allowJs the
    // symbol resolver yields no default export for those.
    compilerOptions: { allowJs: true },
  });

  let sourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(configPath);
  } catch (err) {
    recordConfidenceDecision('proxy-config: failed to parse Vite config', {
      'proxy.configPath': configPath,
      'proxy.error': err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  // Find the default export. It can be either:
  //   export default defineConfig({ ... })
  //   export default { ... }
  //   const config = { ... };
  //   export default config;
  const defaultExportExpr = sourceFile.getDefaultExportSymbol()
    ?.getDeclarations()
    ?.[0];
  if (!defaultExportExpr) return [];

  // ExportAssignment node: `export default <expr>`.
  // VariableDeclaration node: `export default someName` resolves to that name's decl.
  let configExpr: Node | undefined;
  if (Node.isExportAssignment(defaultExportExpr)) {
    configExpr = defaultExportExpr.getExpression();
  } else if (Node.isVariableDeclaration(defaultExportExpr)) {
    configExpr = defaultExportExpr.getInitializer();
  }
  if (!configExpr) return [];

  // Unwrap defineConfig(<obj>) or defineConfig(({ mode }) => ({ ... })).
  const configObj = unwrapToObjectLiteral(configExpr);
  if (!configObj) {
    recordConfidenceDecision('proxy-config: Vite default export is not a static object literal', {
      'proxy.configPath': configPath,
    });
    return [];
  }

  // server.proxy
  const server = getPropertyInitializer(configObj, 'server');
  if (!server || !Node.isObjectLiteralExpression(server)) return [];
  const proxy = getPropertyInitializer(server, 'proxy');
  if (!proxy || !Node.isObjectLiteralExpression(proxy)) return [];

  const rules: ProxyRule[] = [];
  for (const prop of proxy.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;

    const nameNode = prop.getNameNode();
    let prefix: string;
    if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
      prefix = nameNode.getLiteralValue();
    } else if (Node.isIdentifier(nameNode)) {
      // Bare identifier keys (`api: { ... }`) are valid JS but rare
      // for proxy entries which are URL prefixes. Skip — they'd
      // never match a URL anyway.
      continue;
    } else {
      continue;
    }

    const valueNode = prop.getInitializer();
    if (!valueNode) continue;

    const filePath = path.relative(path.dirname(configPath), configPath) || path.basename(configPath);
    const lineStart = prop.getStartLineNumber();

    // Two value shapes: a plain string (just the upstream URL) or
    // an object `{ target, rewrite, ... }`.
    if (Node.isStringLiteral(valueNode) || Node.isNoSubstitutionTemplateLiteral(valueNode)) {
      rules.push({
        prefix,
        stripsPrefix: false, // no rewrite declared
        upstreamTarget: valueNode.getLiteralValue(),
        evidence: { filePath: configPath, lineStart },
        source: 'vite',
      });
      continue;
    }

    if (Node.isObjectLiteralExpression(valueNode)) {
      const targetNode = getPropertyInitializer(valueNode, 'target');
      let upstreamTarget: string | null = null;
      if (targetNode && (Node.isStringLiteral(targetNode) || Node.isNoSubstitutionTemplateLiteral(targetNode))) {
        upstreamTarget = targetNode.getLiteralValue();
      }

      const rewriteNode = getPropertyInitializer(valueNode, 'rewrite');
      const stripsPrefix = detectRewriteStripsPrefix(rewriteNode, prefix, configPath);

      rules.push({
        prefix,
        stripsPrefix,
        upstreamTarget,
        evidence: { filePath: configPath, lineStart },
        source: 'vite',
      });
      continue;
    }

    // Anything else (function calls, identifier-bound configs) — record
    // a decision and skip rather than guess.
    recordConfidenceDecision('proxy-config: Vite proxy entry value is non-deterministic', {
      'proxy.configPath': configPath,
      'proxy.prefix': prefix,
      'proxy.valueKind': valueNode.getKindName(),
    });
  }

  return rules;
}

/**
 * Detect whether a `rewrite` arrow function strips its prefix.
 *
 * Recognized shapes (deterministic only):
 *   - missing rewrite                              → returns false (upstream sees full path)
 *   - `(p) => p.replace(/^\/<prefix>/, '')`         → returns true
 *   - `(p) => p.replace(/^\/<prefix>/, '/')`        → returns true (treat as strip)
 *   - anything else (custom fn, identifier-bound)  → records decision, returns false
 */
function detectRewriteStripsPrefix(
  rewriteNode: Node | undefined,
  prefix: string,
  configPath: string
): boolean {
  if (!rewriteNode) return false;

  if (!Node.isArrowFunction(rewriteNode) && !Node.isFunctionExpression(rewriteNode)) {
    recordConfidenceDecision('proxy-config: rewrite is not an inline function', {
      'proxy.configPath': configPath,
      'proxy.prefix': prefix,
      'proxy.rewriteKind': rewriteNode.getKindName(),
    });
    return false;
  }

  // Body: either an expression (arrow with expression body) or a
  // block whose single statement is a return.
  const body = rewriteNode.getBody();
  let returnExpr: Node | undefined;
  if (Node.isBlock(body)) {
    const stmts = body.getStatements();
    if (stmts.length !== 1) {
      recordConfidenceDecision('proxy-config: rewrite body is not a single return statement', {
        'proxy.configPath': configPath,
        'proxy.prefix': prefix,
      });
      return false;
    }
    const stmt = stmts[0];
    if (!Node.isReturnStatement(stmt)) return false;
    returnExpr = stmt.getExpression();
  } else {
    returnExpr = body;
  }
  if (!returnExpr) return false;

  // Look for `<receiver>.replace(<regex>, <replacement>)`.
  if (!Node.isCallExpression(returnExpr)) return false;
  const callee = returnExpr.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  if (callee.getNameNode().getText() !== 'replace') return false;

  const args = returnExpr.getArguments();
  if (args.length < 2) return false;

  // First arg: a RegularExpressionLiteral whose source matches `^<prefix>` exactly.
  const regex = args[0];
  if (regex.getKind() !== SyntaxKind.RegularExpressionLiteral) {
    recordConfidenceDecision('proxy-config: rewrite first arg is not a regex literal', {
      'proxy.configPath': configPath,
      'proxy.prefix': prefix,
    });
    return false;
  }

  const regexText = regex.getText(); // e.g. '/^\\/api/' or '/^\\/api\\//'
  // Strip leading and trailing `/` plus flags. Match anchor `^` then
  // a slash-escaped version of `prefix`.
  const inner = regexText.slice(1, regexText.lastIndexOf('/'));
  // Build the canonical "matches the prefix at the start" pattern.
  // Vite-style rewrites typically anchor at `^` and may or may not
  // include the trailing `/`. The regex source escapes `/` as `\/`,
  // so we escape it the same way when constructing the expected form
  // (in addition to the standard regex metacharacters).
  const escapedPrefix = prefix.replace(/[\\/.*+?^${}()|[\]]/g, '\\$&');
  const expectedAnchor = `^${escapedPrefix}`;
  if (inner !== expectedAnchor && inner !== expectedAnchor + '\\/') {
    recordConfidenceDecision('proxy-config: rewrite regex does not match expected strip-prefix shape', {
      'proxy.configPath': configPath,
      'proxy.prefix': prefix,
      'proxy.regex': regexText,
    });
    return false;
  }

  // Second arg: a string literal that's empty or just '/'. Either is
  // a "strips the prefix" replacement.
  const replacement = args[1];
  if (
    !Node.isStringLiteral(replacement) &&
    !Node.isNoSubstitutionTemplateLiteral(replacement)
  ) {
    return false;
  }
  const repText = replacement.getLiteralValue();
  return repText === '' || repText === '/';
}

// ──────────────────────────────────────────────────────────────────────
// AST helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Strip a `defineConfig(...)` wrapper or arrow-returning-config wrapper
 * to reach the underlying ObjectLiteralExpression. Returns null when
 * the shape isn't a static object literal we can reason about.
 */
function unwrapToObjectLiteral(expr: Node): Node | null {
  // `defineConfig({ ... })` or `defineConfig((env) => ({ ... }))`.
  if (Node.isCallExpression(expr)) {
    const args = expr.getArguments();
    if (args.length === 0) return null;
    return unwrapToObjectLiteral(args[0]);
  }
  // `(env) => ({ ... })` — parenthesized object literal as expression body.
  if (Node.isArrowFunction(expr)) {
    const body = expr.getBody();
    if (Node.isParenthesizedExpression(body)) {
      return unwrapToObjectLiteral(body.getExpression());
    }
    if (Node.isObjectLiteralExpression(body)) return body;
    return null;
  }
  if (Node.isParenthesizedExpression(expr)) {
    return unwrapToObjectLiteral(expr.getExpression());
  }
  if (Node.isObjectLiteralExpression(expr)) {
    return expr;
  }
  // Identifier: follow to the variable's initializer.
  if (Node.isIdentifier(expr)) {
    const sym = expr.getSymbol();
    const decls = sym?.getDeclarations() ?? [];
    for (const decl of decls) {
      if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        if (init) return unwrapToObjectLiteral(init);
      }
    }
  }
  return null;
}

/**
 * Look up a named property on an ObjectLiteralExpression and return
 * its initializer node. Skips spread elements and computed keys.
 */
function getPropertyInitializer(obj: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  for (const prop of obj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const nameNode = prop.getNameNode();
    let key: string;
    if (Node.isIdentifier(nameNode)) key = nameNode.getText();
    else if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
      key = nameNode.getLiteralValue();
    } else continue;
    if (key === name) return prop.getInitializer() ?? undefined;
  }
  return undefined;
}
