import * as fs from 'node:fs';
import * as path from 'node:path';
import { Project, Node, type SourceFile, type Expression, type ObjectLiteralExpression } from 'ts-morph';
import {
  idFor,
  type BundlesToEdge,
  type SchemaEdge,
  type SchemaNode,
  type SourceFile as SourceFileNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { recordConfidenceDecision } from '@adorable/observability';
import { evalConstant } from './eval-constant.js';

/**
 * Bundler config parser (#197).
 *
 * Locates webpack/vite/rollup/esbuild config files at the project
 * root (or a few canonical sub-paths), parses them with ts-morph,
 * and extracts the `entry` map: a mapping from logical entry name
 * to source file path.
 *
 * For each entry, emits:
 *   - SourceFile node for the entry's source file (the TS/JS file
 *     the bundler reads).
 *   - SourceFile node for the bundle output (a synthetic
 *     `<output.path>/<filename>` path that lang-html's
 *     `<script src>` resolution would target).
 *   - BUNDLES_TO edge: bundle SourceFile → entry SourceFile.
 *
 * The output filename pattern must include `[name]` to be
 * deterministically resolvable. Fingerprinted patterns
 * (`[contenthash]`) record a ConfidenceDecision and skip emission
 * for that config.
 */

export type Bundler = 'webpack' | 'vite' | 'rollup' | 'esbuild';

interface BundlerConfigFile {
  bundler: Bundler;
  /** Absolute path to the config file. */
  abs: string;
  /** Relative-to-rootDir POSIX path. */
  rel: string;
}

const CONFIG_PATTERNS: Array<{ bundler: Bundler; names: ReadonlyArray<string> }> = [
  {
    bundler: 'webpack',
    names: [
      'webpack.config.js', 'webpack.config.ts', 'webpack.config.mjs', 'webpack.config.cjs',
      'webpack_config.js', 'webpack_config.ts', // legacy snake-case style.
    ],
  },
  {
    bundler: 'vite',
    names: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'],
  },
  {
    bundler: 'rollup',
    names: ['rollup.config.js', 'rollup.config.ts', 'rollup.config.mjs', 'rollup.config.cjs'],
  },
  {
    bundler: 'esbuild',
    names: ['esbuild.config.js', 'esbuild.config.ts', 'esbuild.config.mjs'],
  },
];

/**
 * Find every bundler config under `rootDir`. The orchestrator walks
 * the project tree once and passes a `files` list to plugins, but
 * for #197 we explicitly scan two locations: the root and any
 * immediate subdirectory (multi-bundle layouts like
 * `static-site/site-client-src/webpack_config.js` are common).
 */
export function findBundlerConfigs(rootDir: string): BundlerConfigFile[] {
  const out: BundlerConfigFile[] = [];

  // Scan root + one level deep.
  const dirsToScan: string[] = [rootDir];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build') continue;
    dirsToScan.push(path.join(rootDir, name));
  }

  for (const dir of dirsToScan) {
    for (const pattern of CONFIG_PATTERNS) {
      for (const filename of pattern.names) {
        const abs = path.join(dir, filename);
        if (fs.existsSync(abs)) {
          const rel = path.relative(rootDir, abs).split(path.sep).join('/');
          out.push({ bundler: pattern.bundler, abs, rel });
        }
      }
    }
  }
  return out;
}

export interface BundlerEntryFinding {
  /** Logical entry name. For a single-string entry, defaults to 'main'. */
  name: string;
  /** Resolved entry source path (relative to rootDir, POSIX). */
  entryPath: string;
  /** Output bundle path (synthetic — `<output.path>/<filename-with-[name]-substituted>`). */
  bundleOutputPath: string;
  /** Bundler tool that produced this entry. */
  bundler: Bundler;
  /** Path of the config file relative to rootDir. */
  configPath: string;
}

/**
 * Parse a config file and return its discovered entries. Returns []
 * on:
 *   - malformed source / parse failure (logged via ConfidenceDecision).
 *   - non-static-resolvable entry shapes.
 *   - fingerprinted output filename patterns.
 *   - function-returned configs (`module.exports = (env) => ({...})`).
 */
export function parseBundlerConfig(cfg: BundlerConfigFile, rootDir: string): BundlerEntryFinding[] {
  let source: string;
  try {
    source = fs.readFileSync(cfg.abs, 'utf8');
  } catch (err) {
    recordConfidenceDecision(`bundler config read failed`, {
      'bundler.path': cfg.abs,
      'bundler.error': String(err instanceof Error ? err.message : err),
    });
    return [];
  }

  // Use a fresh ts-morph Project so our parse is isolated from the
  // user's main TS Project. We don't need full type-checking here —
  // just AST.
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, noEmit: true, skipLibCheck: true, target: 99 },
  });
  let sf: SourceFile;
  try {
    sf = project.createSourceFile(cfg.abs, source, { overwrite: true });
  } catch (err) {
    recordConfidenceDecision(`bundler config parse failed`, {
      'bundler.path': cfg.abs,
      'bundler.error': String(err instanceof Error ? err.message : err),
    });
    return [];
  }

  const configObj = findConfigObjectLiteral(sf);
  if (!configObj) {
    recordConfidenceDecision(`bundler config object literal not found`, {
      'bundler.path': cfg.abs,
      'bundler.note': 'function-returned configs and complex shapes are out of scope',
    });
    return [];
  }

  // Extract `output.path` and `output.filename`.
  const outputPath = readObjectStringProperty(configObj, 'output', 'path') ?? '';
  const outputFilename = readObjectStringProperty(configObj, 'output', 'filename') ?? '[name].js';

  // Bundler-specific filename extraction.
  // For vite, the output is in `build.rollupOptions.output.entryFileNames` or `build.outDir`. We default to `[name].js`.
  // For rollup, output may be an object or array with `entryFileNames`. Same default.

  if (!outputFilename.includes('[name]')) {
    recordConfidenceDecision(`bundler output filename has no [name] template`, {
      'bundler.path': cfg.abs,
      'bundler.outputFilename': outputFilename,
    });
    return [];
  }
  // Reject fingerprinted patterns — `[contenthash]`, `[hash]`,
  // `[chunkhash]` cannot be matched to a deterministic output
  // without running the build.
  if (/\[(contenthash|hash|chunkhash|fullhash)/i.test(outputFilename)) {
    recordConfidenceDecision(`bundler output filename is fingerprinted`, {
      'bundler.path': cfg.abs,
      'bundler.outputFilename': outputFilename,
    });
    return [];
  }

  // Extract the entry property.
  const entryProp = configObj.getProperty('entry');
  if (!entryProp || !Node.isPropertyAssignment(entryProp)) {
    return [];
  }
  const entryInit = entryProp.getInitializer();
  if (!entryInit) return [];

  const findings: BundlerEntryFinding[] = [];

  if (Node.isStringLiteral(entryInit) || Node.isNoSubstitutionTemplateLiteral(entryInit)) {
    // entry: 'src/index.ts' → one entry named 'main'.
    const v = evalConstant(entryInit);
    if (v) findings.push(makeFinding('main', v, outputPath, outputFilename, cfg));
  } else if (Node.isCallExpression(entryInit) || Node.isTemplateExpression(entryInit) || Node.isPropertyAccessExpression(entryInit) || Node.isIdentifier(entryInit)) {
    const v = evalConstant(entryInit);
    if (v) findings.push(makeFinding('main', v, outputPath, outputFilename, cfg));
  } else if (Node.isObjectLiteralExpression(entryInit)) {
    for (const prop of entryInit.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const nameNode = prop.getNameNode();
      let entryName: string | null = null;
      if (Node.isIdentifier(nameNode)) entryName = nameNode.getText();
      else if (Node.isStringLiteral(nameNode)) entryName = nameNode.getLiteralValue();
      if (!entryName) continue;
      const valueExpr = prop.getInitializer();
      if (!valueExpr) continue;
      const resolved = evalConstant(valueExpr);
      if (resolved) findings.push(makeFinding(entryName, resolved, outputPath, outputFilename, cfg));
      else {
        recordConfidenceDecision(`bundler entry value not statically resolvable`, {
          'bundler.path': cfg.abs,
          'bundler.entryName': entryName,
          'call.sourceLine': prop.getStartLineNumber(),
        });
      }
    }
  } else if (Node.isArrayLiteralExpression(entryInit)) {
    // entry: ['src/a.ts', 'src/b.ts'] → multiple files into one bundle 'main'.
    // Treat as a single logical entry pointing at the first file
    // (the others are dependencies of the same bundle).
    const els = entryInit.getElements();
    if (els.length > 0) {
      const v = evalConstant(els[0] as Expression);
      if (v) findings.push(makeFinding('main', v, outputPath, outputFilename, cfg));
    }
  }

  // Normalize entry + bundle output paths to be rootDir-relative
  // POSIX paths. Some bundler configs use absolute paths
  // (`path.resolve('/abs/build')`); strip the rootDir prefix when
  // present. Without this normalization an absolute `output.path`
  // produces a SourceFile id that lang-html's `<script src>`
  // resolver — which works in relative space — can't match.
  const rootDirPosix = rootDir.split(path.sep).join('/');
  const normalize = (p: string): string => {
    if (p.startsWith(rootDirPosix + '/')) return p.slice(rootDirPosix.length + 1);
    if (p.startsWith('./')) return p.slice(2);
    return p;
  };
  for (const f of findings) {
    f.entryPath = normalize(f.entryPath);
    f.bundleOutputPath = normalize(f.bundleOutputPath);
  }

  return findings;
}

function makeFinding(
  name: string,
  rawEntryPath: string,
  outputPath: string,
  outputFilename: string,
  cfg: BundlerConfigFile,
): BundlerEntryFinding {
  const filename = outputFilename.replace(/\[name\]/g, name);
  const bundleOutputPath = outputPath ? joinPosix([outputPath, filename]) : filename;
  return {
    name,
    entryPath: rawEntryPath,
    bundleOutputPath,
    bundler: cfg.bundler,
    configPath: cfg.rel,
  };
}

function joinPosix(parts: string[]): string {
  if (parts.length === 0) return '';
  return parts
    .map((p, i) => (i === 0 ? p : p.replace(/^\/+/, '')))
    .map((p, i, arr) => (i === arr.length - 1 ? p : p.replace(/\/+$/, '')))
    .join('/')
    .replace(/\/{2,}/g, '/');
}

/**
 * Find the top-level config object literal in a bundler config file.
 *
 * Recognized shapes:
 *   - `module.exports = { ... };` (CommonJS).
 *   - `export default { ... };` (ESM default).
 *   - `module.exports = defineConfig({ ... });` (Vite/Rollup helper).
 *   - `export default defineConfig({ ... });` (same).
 *
 * Function-returned configs (`module.exports = (env) => ({...})`)
 * are out of scope — the env-resolution can't be done statically.
 */
function findConfigObjectLiteral(sf: SourceFile): ObjectLiteralExpression | null {
  // Try ESM `export default X`.
  for (const ed of sf.getExportAssignments()) {
    const expr = ed.getExpression();
    const obj = unwrapToObjectLiteral(expr);
    if (obj) return obj;
  }

  // Walk top-level `module.exports = ...` and `exports.<x> = ...`.
  for (const stmt of sf.getStatements()) {
    if (!Node.isExpressionStatement(stmt)) continue;
    const e = stmt.getExpression();
    if (!Node.isBinaryExpression(e)) continue;
    if (e.getOperatorToken().getText() !== '=') continue;
    const lhs = e.getLeft();
    const lhsText = lhs.getText();
    if (lhsText !== 'module.exports' && lhsText !== 'exports.default') continue;
    const obj = unwrapToObjectLiteral(e.getRight());
    if (obj) return obj;
  }

  return null;
}

function unwrapToObjectLiteral(expr: Expression): ObjectLiteralExpression | null {
  if (Node.isObjectLiteralExpression(expr)) return expr;
  // defineConfig({...}) wrapper.
  if (Node.isCallExpression(expr)) {
    const args = expr.getArguments();
    if (args.length > 0 && Node.isObjectLiteralExpression(args[0])) {
      return args[0];
    }
  }
  return null;
}

function readObjectStringProperty(
  obj: ObjectLiteralExpression,
  ...keys: string[]
): string | null {
  let cursor: Expression | undefined = obj as Expression;
  for (const k of keys) {
    if (!cursor || !Node.isObjectLiteralExpression(cursor)) return null;
    const prop: Node | undefined = cursor.getProperty(k);
    if (!prop || !Node.isPropertyAssignment(prop)) return null;
    const init: Expression | undefined = prop.getInitializer();
    if (!init) return null;
    cursor = init;
  }
  if (!cursor) return null;
  return evalConstant(cursor);
}

/**
 * Scan rootDir for bundler configs, parse each, and emit
 * SourceFile + BUNDLES_TO nodes/edges.
 */
export function extractBundles(rootDir: string, repository: string): NodeBatch {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const seenSourceFileIds = new Set<string>();

  const configs = findBundlerConfigs(rootDir);
  for (const cfg of configs) {
    const findings = parseBundlerConfig(cfg, rootDir);
    for (const f of findings) {
      const entryFileId = idFor.sourceFile({ repository, filePath: f.entryPath });
      const bundleFileId = idFor.sourceFile({ repository, filePath: f.bundleOutputPath });

      if (!seenSourceFileIds.has(entryFileId)) {
        seenSourceFileIds.add(entryFileId);
        const entrySf: SourceFileNode = {
          nodeType: 'SourceFile',
          id: entryFileId,
          filePath: f.entryPath,
          repository,
          language: f.entryPath.endsWith('.ts') || f.entryPath.endsWith('.tsx') ? 'ts' : 'js',
          framework: null,
        };
        nodes.push(entrySf);
      }

      if (!seenSourceFileIds.has(bundleFileId)) {
        seenSourceFileIds.add(bundleFileId);
        const bundleSf: SourceFileNode = {
          nodeType: 'SourceFile',
          id: bundleFileId,
          filePath: f.bundleOutputPath,
          repository,
          language: 'js',
          framework: `bundler-${f.bundler}`,
        };
        nodes.push(bundleSf);
      }

      const edge: BundlesToEdge = {
        edgeType: 'BUNDLES_TO',
        from: bundleFileId,
        to: entryFileId,
        bundler: f.bundler,
        entryName: f.name,
        configPath: f.configPath,
      };
      edges.push(edge);
    }
  }

  return { nodes, edges };
}
