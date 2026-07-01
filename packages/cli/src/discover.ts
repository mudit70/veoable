import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  DependencyManifestRecord,
  FrameworkPlugin,
  LanguagePlugin,
  ManifestRecord,
  ProjectContext,
} from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { JavaLanguagePlugin } from '@adorable/lang-java';
import { PhpLanguagePlugin } from '@adorable/lang-php';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { HtmlLanguagePlugin, HTML_FILE_EXTENSIONS } from '@adorable/lang-html';
import { PrismaPlugin } from '@adorable/framework-prisma';
import { ReactPlugin } from '@adorable/framework-react';
import { ExpressPlugin } from '@adorable/framework-express';
import { FastifyPlugin } from '@adorable/framework-fastify';
import { NestjsPlugin } from '@adorable/framework-nestjs';
import { NextjsPlugin } from '@adorable/framework-nextjs';
import { SupabasePlugin } from '@adorable/framework-supabase';
import { TypeormPlugin } from '@adorable/framework-typeorm';
import { DrizzlePlugin } from '@adorable/framework-drizzle';
import { MikroOrmPlugin } from '@adorable/framework-mikroorm';
import { SequelizePlugin } from '@adorable/framework-sequelize';
import { KnexPlugin } from '@adorable/framework-knex';
import { MongoosePlugin } from '@adorable/framework-mongoose';
import { AxiosPlugin } from '@adorable/framework-axios';
import { FetchPlugin } from '@adorable/framework-fetch';
import { RpcClientPlugin } from '@adorable/framework-rpc-client';
import { FastapiPlugin } from '@adorable/framework-fastapi';
import { SqlalchemyPlugin } from '@adorable/framework-sqlalchemy';
import { DjangoPlugin } from '@adorable/framework-django';
import { FlaskPlugin } from '@adorable/framework-flask';
import { HttpxPlugin } from '@adorable/framework-httpx';
import { GrpcioPlugin } from '@adorable/framework-grpcio';
import { AiohttpPlugin } from '@adorable/framework-aiohttp';
import { CeleryPlugin } from '@adorable/framework-celery';
import { TornadoPlugin } from '@adorable/framework-tornado';
import { PymongoPlugin } from '@adorable/framework-pymongo';
import { RedispyPlugin } from '@adorable/framework-redispy';
import { Boto3Plugin } from '@adorable/framework-boto3';
import { GcsPyPlugin } from '@adorable/framework-gcs-py';
import { AzureBlobPyPlugin } from '@adorable/framework-azure-blob-py';
import { KafkapyPlugin } from '@adorable/framework-kafkapy';
import { PikaPlugin } from '@adorable/framework-pika';
import { WsPyPlugin } from '@adorable/framework-ws-py';
import { ElasticPyPlugin } from '@adorable/framework-elastic-py';
import { MemcachePyPlugin } from '@adorable/framework-memcache-py';
import { PeeweePlugin } from '@adorable/framework-peewee';
import { TortoisePlugin } from '@adorable/framework-tortoise';
import { SqlmodelPlugin } from '@adorable/framework-sqlmodel';
import { TrpcPlugin } from '@adorable/framework-trpc';
import { GraphqlPlugin } from '@adorable/framework-graphql';
import { VuePlugin } from '@adorable/framework-vue';
import { KoaPlugin } from '@adorable/framework-koa';
import { HapiPlugin } from '@adorable/framework-hapi';
import { HonoPlugin } from '@adorable/framework-hono';
import { RemixPlugin } from '@adorable/framework-remix';
import { AngularPlugin } from '@adorable/framework-angular';
import { SveltePlugin } from '@adorable/framework-svelte';
import { ReactQueryPlugin } from '@adorable/framework-react-query';
import { SwrPlugin } from '@adorable/framework-swr';
import { TrpcClientPlugin } from '@adorable/framework-trpc-client';
import { StateMgmtPlugin } from '@adorable/framework-state-mgmt';
import { DomPlugin } from '@adorable/framework-dom';
import { GinPlugin } from '@adorable/framework-gin';
import { EchoPlugin } from '@adorable/framework-echo';
import { FiberPlugin } from '@adorable/framework-fiber';
import { GoHttpPlugin } from '@adorable/framework-gohttp';
import { GrpcgoPlugin } from '@adorable/framework-grpcgo';
import { GosqlxPlugin } from '@adorable/framework-gosqlx';
import { ChiPlugin } from '@adorable/framework-chi';
import { MongogoPlugin } from '@adorable/framework-mongogo';
import { GoredisPlugin } from '@adorable/framework-goredis';
import { AsynqPlugin } from '@adorable/framework-asynq';
import { KafkagoPlugin } from '@adorable/framework-kafkago';
import { WsGoPlugin } from '@adorable/framework-ws-go';
import { ElasticGoPlugin } from '@adorable/framework-elastic-go';
import { MemcacheGoPlugin } from '@adorable/framework-memcache-go';
import { EntPlugin } from '@adorable/framework-ent';
import { AwsgoS3Plugin } from '@adorable/framework-awsgo-s3';
import { GcsGoPlugin } from '@adorable/framework-gcs-go';
import { AzureBlobGoPlugin } from '@adorable/framework-azure-blob-go';
import { ActixPlugin } from '@adorable/framework-actix';
import { AxumPlugin } from '@adorable/framework-axum';
import { WarpPlugin } from '@adorable/framework-warp';
import { PoemPlugin } from '@adorable/framework-poem';
import { RocketPlugin } from '@adorable/framework-rocket';
import { SpringPlugin } from '@adorable/framework-spring';
import { JpaPlugin } from '@adorable/framework-jpa';
import { GormPlugin } from '@adorable/framework-gorm';
import { LaravelPlugin } from '@adorable/framework-laravel';
import { PycliPlugin } from '@adorable/framework-pycli';
import { GocliPlugin } from '@adorable/framework-gocli';
import { RustcliPlugin } from '@adorable/framework-rustcli';
import { ReactNativePlugin } from '@adorable/framework-react-native';
import { ReactRouterPlugin } from '@adorable/framework-react-router';
import { RedirectsPlugin } from '@adorable/framework-redirects';
import { BundlerPlugin } from '@adorable/framework-bundler';
import { BullmqPlugin } from '@adorable/framework-bullmq';
import { KafkajsPlugin } from '@adorable/framework-kafkajs';
import { AmqplibPlugin } from '@adorable/framework-amqplib';
import { Amqp091GoPlugin } from '@adorable/framework-amqp091-go';
import { AwsS3TsPlugin } from '@adorable/framework-aws-s3-ts';
import { GcsTsPlugin } from '@adorable/framework-gcs-ts';
import { AzureBlobTsPlugin } from '@adorable/framework-azure-blob-ts';
import { IoredisPlugin } from '@adorable/framework-ioredis';
import { GrpcNodePlugin } from '@adorable/framework-grpc-node';
import { WsTsPlugin } from '@adorable/framework-ws-ts';
import { ElasticTsPlugin } from '@adorable/framework-elastic-ts';
import { MemcacheTsPlugin } from '@adorable/framework-memcache-ts';
import { MCPServerPlugin } from '@adorable/framework-mcp-server';
import { SqlxPlugin } from '@adorable/framework-sqlx';
import { DieselPlugin } from '@adorable/framework-diesel';
import { TonicPlugin } from '@adorable/framework-tonic';
import { MCPServerRustPlugin } from '@adorable/framework-mcp-server-rust';
import { TokioSpawnPlugin } from '@adorable/framework-tokio-spawn';
import { ReqwestPlugin } from '@adorable/framework-reqwest';
import { SeaormPlugin } from '@adorable/framework-seaorm';
import { MongorustPlugin } from '@adorable/framework-mongorust';
import { RedisrsPlugin } from '@adorable/framework-redisrs';
import { ApalisPlugin } from '@adorable/framework-apalis';
import { AwsrustS3Plugin } from '@adorable/framework-awsrust-s3';
import { GcsRsPlugin } from '@adorable/framework-gcs-rs';
import { AzureBlobRsPlugin } from '@adorable/framework-azure-blob-rs';
import { KafkarsPlugin } from '@adorable/framework-kafkars';
import { WsRsPlugin } from '@adorable/framework-ws-rs';
import { ElasticRsPlugin } from '@adorable/framework-elastic-rs';
import { MemcacheRsPlugin } from '@adorable/framework-memcache-rs';
import { LapinPlugin } from '@adorable/framework-lapin';

// ──────────────────────────────────────────────────────────────────────
// Language registry (#141)
// ──────────────────────────────────────────────────────────────────────

interface LanguageEntry {
  /** Factory — called once per analysis run for fresh state. */
  createPlugin: () => LanguagePlugin;
  /** File extensions this language claims (with leading dot). */
  extensions: ReadonlySet<string>;
  /** Test-file patterns to exclude. */
  testPatterns?: RegExp[];
  /** Declaration file suffixes to exclude. */
  declarationSuffixes?: string[];
}

/**
 * All known language plugins. Add entries here when new languages
 * (Python, Go, Java, PHP) are implemented.
 */
const LANGUAGE_REGISTRY: Record<string, LanguageEntry> = {
  ts: {
    createPlugin: () => new TsLanguagePlugin(),
    extensions: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']),
    testPatterns: [/\.(test|spec)\./],
    declarationSuffixes: ['.d.ts', '.d.mts', '.d.cts'],
  },
  py: {
    createPlugin: () => new PyLanguagePlugin(),
    extensions: new Set(['.py']),
    testPatterns: [/^test_/, /_test\.py$/],
  },
  go: {
    createPlugin: () => new GoLanguagePlugin(),
    extensions: new Set(['.go']),
    testPatterns: [/_test\.go$/],
  },
  java: {
    createPlugin: () => new JavaLanguagePlugin(),
    extensions: new Set(['.java']),
    testPatterns: [/Test\.java$/, /Tests\.java$/],
  },
  php: {
    createPlugin: () => new PhpLanguagePlugin(),
    extensions: new Set(['.php']),
    testPatterns: [/Test\.php$/],
  },
  rust: {
    createPlugin: () => new RustLanguagePlugin(),
    extensions: new Set(['.rs']),
    testPatterns: [/_test\.rs$/],
  },
  html: {
    createPlugin: () => new HtmlLanguagePlugin(),
    extensions: new Set(HTML_FILE_EXTENSIONS),
  },
};

/** All file extensions across all registered languages. */
export function allSourceExtensions(): Set<string> {
  const exts = new Set<string>();
  for (const entry of Object.values(LANGUAGE_REGISTRY)) {
    for (const ext of entry.extensions) exts.add(ext);
  }
  return exts;
}

/** Get the language ID for a file extension, or null if unsupported. */
export function languageForExtension(ext: string): string | null {
  for (const [lang, entry] of Object.entries(LANGUAGE_REGISTRY)) {
    if (entry.extensions.has(ext)) return lang;
  }
  return null;
}

/** Create language plugin instances for the given language IDs. */
export function createLanguagePlugins(languages: Iterable<string>): Map<string, LanguagePlugin> {
  const plugins = new Map<string, LanguagePlugin>();
  for (const lang of languages) {
    const entry = LANGUAGE_REGISTRY[lang];
    if (entry) plugins.set(lang, entry.createPlugin());
  }
  return plugins;
}

// ──────────────────────────────────────────────────────────────────────
// File discovery
// ──────────────────────────────────────────────────────────────────────

const DEFAULT_EXCLUDES = [
  'node_modules',
  'bower_components', // legacy JS package dir (jQuery-era)
  'dist',
  'build',
  'out',
  '.git',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',   // Java/Rust build output
  'vendor',   // Go/PHP deps
];

/**
 * Recognise vendored JS bundles shipped inside a repo's source tree
 * (think `assets/js/libs/jquery-ui.js`). ts-morph parses these
 * happily but spends seconds-to-minutes per file with no useful
 * output — none of our framework plugins target jQuery or moment.
 *
 * Two filters:
 *   1. Filename patterns for the canonical vendored shapes
 *      (`*.min.js`, well-known runtime names).
 *   2. For *.js / *.mjs over 100 KB: peek the first 4 KB and skip
 *      when the average line length is >200 chars (the classic
 *      minified-bundle signature).
 *
 * TS / TSX / JSX files are *not* sampled — they're virtually never
 * minified, and the small overhead of statting every TS file across
 * a monorepo isn't worth catching the near-zero case.
 */
// Only filename shapes that are unambiguous vendored markers:
//   .min.js / -min.js  → minified output (never hand-authored)
//   -vendor.js         → conventional vendored-bundle suffix
//   .umd.js            → UMD-wrapped distributable
// `.bundle.js` and `.pack.js` are NOT here — webpack/browserify config
// and tool files use those names as plain source. The content sniff
// below catches real vendored bundles with those names.
const VENDORED_FILENAME_RE = /(?:\.min|-min|-vendor|\.umd)\.(?:js|mjs)$/i;
// Filenames so iconic that we treat them as vendored on sight — but
// gated on a size floor (KNOWN_VENDOR_MIN_SIZE) so a hand-written
// `react.development.js` of a few KB isn't mistaken for the real one.
const KNOWN_VENDOR_NAMES = new Set([
  'jquery.js',
  'jquery-ui.js',
  'moment.js',
  'moment-with-locales.js',
  'vue.global.js',
  'vue.runtime.global.js',
  'angular.js',
  'react.development.js',
  'react.production.min.js',
]);
const KNOWN_VENDOR_MIN_SIZE = 50 * 1024;   // 50 KB
const VENDORED_SIZE_THRESHOLD = 100 * 1024; // 100 KB
const VENDORED_AVG_LINE_LEN = 200;
const VENDOR_SAMPLE_BYTES = 4096;

function looksLikeVendoredBundle(absPath: string, name: string): boolean {
  if (VENDORED_FILENAME_RE.test(name)) return true;
  // Content sniff only on plain JS/MJS at substantial size.
  if (!/\.(?:js|mjs)$/i.test(name)) return false;
  let size: number;
  try {
    size = fs.statSync(absPath).size;
  } catch {
    return false;
  }
  if (KNOWN_VENDOR_NAMES.has(name.toLowerCase()) && size >= KNOWN_VENDOR_MIN_SIZE) {
    return true;
  }
  if (size < VENDORED_SIZE_THRESHOLD) return false;
  try {
    const fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(VENDOR_SAMPLE_BYTES);
    const read = fs.readSync(fd, buf, 0, VENDOR_SAMPLE_BYTES, 0);
    fs.closeSync(fd);
    if (read === 0) return false;
    const sample = buf.subarray(0, read).toString('utf8');
    const newlines = (sample.match(/\n/g) ?? []).length;
    if (newlines === 0) return true; // single-line file > 100 KB → minified
    return sample.length / newlines > VENDORED_AVG_LINE_LEN;
  } catch {
    return false;
  }
}

/**
 * Recursively find every source file under `rootDir`, excluding
 * common non-source directories, declaration files, and test files.
 * Accepts an optional set of extensions to restrict scanning.
 */
export function discoverSourceFiles(
  rootDir: string,
  opts: { exclude?: string[]; extensions?: Set<string> } = {}
): string[] {
  const sourceExtensions = opts.extensions ?? allSourceExtensions();
  const excludeDirs = new Set([...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])]);
  const files: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!sourceExtensions.has(ext)) continue;

        // Check language-specific exclusions.
        const lang = languageForExtension(ext);
        if (lang) {
          const langEntry = LANGUAGE_REGISTRY[lang];
          if (langEntry.declarationSuffixes?.some((s) => entry.name.endsWith(s))) continue;
          if (langEntry.testPatterns?.some((p) => p.test(entry.name))) continue;
        }

        // Skip vendored JS bundles — see looksLikeVendoredBundle.
        if (lang === 'ts' && looksLikeVendoredBundle(path.join(dir, entry.name), entry.name)) {
          continue;
        }

        files.push(path.relative(rootDir, path.join(dir, entry.name)));
      }
    }
  };
  walk(rootDir);
  return files.sort();
}

/**
 * Group files by their language ID.
 */
export function groupFilesByLanguage(files: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const ext = path.extname(file);
    const lang = languageForExtension(ext);
    if (!lang) continue;
    const list = groups.get(lang) ?? [];
    list.push(file);
    groups.set(lang, list);
  }
  return groups;
}

// ──────────────────────────────────────────────────────────────────────
// Project context + framework detection
// ──────────────────────────────────────────────────────────────────────

function readTextSafe(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

/**
 * Walk the project tree and collect every `package.json` (root +
 * each subpackage in a monorepo), respecting `DEFAULT_EXCLUDES` plus
 * any user-provided excludes.
 *
 * The root manifest, if present, is always the first entry
 * (`relPath === '.'`). Sub-manifests are sorted by path for stable
 * ordering across runs.
 */
export function discoverManifests(
  rootDir: string,
  opts: { exclude?: string[] } = {},
): ManifestRecord[] {
  const excludeDirs = new Set([...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])]);
  const manifests: ManifestRecord[] = [];

  // Root first.
  const rootPkg = readJsonSafe(path.join(rootDir, 'package.json'));
  if (rootPkg) manifests.push({ relPath: '.', packageJson: rootPkg });

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (excludeDirs.has(entry.name) || entry.name.startsWith('.')) continue;
      const absSub = path.join(dir, entry.name);
      const pkgPath = path.join(absSub, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = readJsonSafe(pkgPath);
        if (pkg) {
          const rel = path.relative(rootDir, absSub).split(path.sep).join('/');
          manifests.push({ relPath: rel || '.', packageJson: pkg });
        }
      }
      walk(absSub);
    }
  };
  walk(rootDir);

  // Stable order: root first, then sub-manifests by path.
  const [first, ...rest] = manifests;
  if (first && first.relPath === '.') {
    rest.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return [first, ...rest];
  }
  manifests.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return manifests;
}

// ──────────────────────────────────────────────────────────────────────
// Workspace metadata discovery (#195)
// ──────────────────────────────────────────────────────────────────────

/**
 * A package that is part of a declared workspace. The `name` is the
 * package's `package.json` name field (used as the import specifier);
 * `relPath` is the directory under `rootDir` where it lives.
 */
export interface WorkspacePackage {
  name: string;
  relPath: string;
}

/**
 * Detect monorepo workspace declarations and return the list of
 * subpackages that are workspace members. Supports:
 *
 * 1. **npm/yarn `workspaces` field**: array OR `{ packages: [...] }` object.
 * 2. **pnpm-workspace.yaml**: `packages:` list (parsed with a minimal
 *    line-based reader since the format is simple and we want to avoid
 *    pulling in a full YAML parser dep).
 *
 * Returns the subset of `manifests` that:
 *   - Have a `name` field in their package.json, AND
 *   - Live at a relative path that matches one of the workspace patterns.
 *
 * Repos with no workspace declaration return an empty array — Layout B
 * monorepos (manual subpackages, no metadata) don't get path synthesis
 * via this function; they rely on the name-based fallback in #200's
 * cross-file resolution work.
 */
export function discoverWorkspacePackages(
  rootDir: string,
  manifests: readonly ManifestRecord[],
): WorkspacePackage[] {
  const patterns = collectWorkspacePatterns(rootDir, manifests);
  if (patterns.length === 0) return [];

  const compiled = patterns.map(globToRegExp);
  const packages: WorkspacePackage[] = [];
  for (const m of manifests) {
    if (m.relPath === '.') continue; // root manifest is not a workspace member
    if (!compiled.some((re) => re.test(m.relPath))) continue;
    const name = (m.packageJson as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) continue;
    packages.push({ name, relPath: m.relPath });
  }
  return packages;
}

/**
 * Synthesize a tsconfig-style `paths` map from declared workspace
 * packages. For each package named `<name>` at `<relPath>`, emits:
 *
 *   "<name>"     → ["<srcEntry>", "<absolutePath>"]
 *   "<name>/*"   → ["<srcDir>/*", "<absolutePath>/*"]
 *
 * `<srcEntry>` is the first source-tree entry-file we can find
 * (`src/index.ts`, `src/index.tsx`, then `index.ts`, then `index.tsx`)
 * and `<srcDir>` is the directory containing it. When no source
 * entry exists, the synthesized list collapses to the package
 * directory alone.
 *
 * Why prefer source entries (#371): real-world workspace packages
 * commonly declare `main: ./dist/index.js` (or `.cjs`). With only
 * the package directory in `paths`, ts-morph follows the package's
 * own `main` resolution and lands on the BUILT JS output — losing
 * type info and the receiver-resolution chain that the source tree
 * carries (singletons, `??` fallbacks, `$extends` wrappers). Putting
 * the source entry FIRST in the array makes ts-morph try it before
 * falling back to whatever the package's own resolution produces.
 *
 * The orchestrator passes the result into language plugins via
 * `loadProject({ compilerPaths: ... })`. Empty input → empty map.
 */
export function synthesizeWorkspaceCompilerPaths(
  rootDir: string,
  packages: readonly WorkspacePackage[],
): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const pkg of packages) {
    const abs = path.join(rootDir, pkg.relPath);
    const srcEntry = findSourceEntry(abs);
    if (srcEntry) {
      const srcDir = path.dirname(srcEntry);
      paths[pkg.name] = [srcEntry, abs];
      paths[`${pkg.name}/*`] = [`${srcDir}/*`, `${abs}/*`];
    } else {
      paths[pkg.name] = [abs];
      paths[`${pkg.name}/*`] = [`${abs}/*`];
    }
  }
  return paths;
}

/**
 * Locate a workspace-package source-tree entry-file to map onto.
 *
 * Order of preference:
 *   1. `package.json` `exports["."]` (string OR conditional record)
 *      pointing at a `.ts`/`.tsx` source file. This catches the
 *      explicit "we ship source" convention (e.g. rallly's
 *      `@rallly/database` exports `./src/client.ts`).
 *   2. `package.json` `main` pointing at a `.ts`/`.tsx` source file.
 *   3. `src/index.ts`, `src/index.tsx` — the most common monorepo
 *      defaults (vite/turbo/nx).
 *   4. `index.ts`, `index.tsx` at the package root.
 *
 * Returns the absolute path of the first existing match, or `null`
 * when none exist. The caller falls back to the package directory.
 *
 * Built JS targets (`./dist/index.js`, `./dist/index.cjs`) are
 * intentionally NOT preferred — preferring them is exactly the
 * #371 regression we're avoiding.
 */
function findSourceEntry(pkgDir: string): string | null {
  // 1+2: declared entries in package.json.
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
      const declared = collectDeclaredEntries(pkg);
      for (const rel of declared) {
        if (!isSourceExtension(rel)) continue;
        const abs = path.resolve(pkgDir, rel);
        if (fs.existsSync(abs)) return abs;
      }
    } catch {
      // Malformed package.json — fall through to convention.
    }
  }
  // 3+4: conventional source-tree entries.
  for (const rel of ['src/index.ts', 'src/index.tsx', 'index.ts', 'index.tsx']) {
    const abs = path.join(pkgDir, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Pull every package.json entry that COULD point at a source file:
 *   - `exports["."]` (string OR conditional record — pick `import`,
 *     `default`, `types`, in that order)
 *   - `main`
 *
 * Returns relative paths in priority order. `exports` wins because
 * it's the modern convention and authors who set it intentionally
 * tend to point at source. `main` is the fallback.
 */
function collectDeclaredEntries(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const exportsField = pkg.exports;
  if (typeof exportsField === 'string') {
    out.push(exportsField);
  } else if (exportsField && typeof exportsField === 'object') {
    const dotEntry = (exportsField as Record<string, unknown>)['.'];
    if (typeof dotEntry === 'string') {
      out.push(dotEntry);
    } else if (dotEntry && typeof dotEntry === 'object') {
      const conditional = dotEntry as Record<string, unknown>;
      for (const key of ['import', 'default', 'types', 'require']) {
        const v = conditional[key];
        if (typeof v === 'string') out.push(v);
      }
    }
  }
  const main = pkg.main;
  if (typeof main === 'string') out.push(main);
  return out;
}

function isSourceExtension(p: string): boolean {
  return p.endsWith('.ts') || p.endsWith('.tsx');
}

/**
 * Pull out workspace-pattern strings from any of the supported
 * declaration formats. Returns relative globs (e.g. `apps/*`).
 */
function collectWorkspacePatterns(
  rootDir: string,
  manifests: readonly ManifestRecord[],
): string[] {
  const patterns: string[] = [];

  // npm / yarn classic — `"workspaces"` field on the root manifest.
  const root = manifests.find((m) => m.relPath === '.');
  if (root) {
    const ws = (root.packageJson as { workspaces?: unknown }).workspaces;
    if (Array.isArray(ws)) {
      for (const p of ws) {
        if (typeof p === 'string') patterns.push(p);
      }
    } else if (ws && typeof ws === 'object') {
      const pkgs = (ws as { packages?: unknown }).packages;
      if (Array.isArray(pkgs)) {
        for (const p of pkgs) {
          if (typeof p === 'string') patterns.push(p);
        }
      }
    }
  }

  // pnpm — `pnpm-workspace.yaml` at the root.
  const pnpmYaml = readTextSafe(path.join(rootDir, 'pnpm-workspace.yaml'));
  if (pnpmYaml) {
    patterns.push(...parsePnpmWorkspacePatterns(pnpmYaml));
  }

  return patterns;
}

/**
 * Minimal `pnpm-workspace.yaml` `packages:` reader. Pnpm's workspace
 * file is structurally simple — a top-level `packages:` key followed
 * by a YAML list of glob patterns. We avoid pulling in a YAML parser
 * dependency for this one shape.
 *
 * Handles:
 *   - Block-list form: `packages:\n  - "apps/*"\n  - "packages/*"`
 *   - Quoted (single/double) and unquoted entries
 *   - Comments after `#`
 *   - Stops cleanly when the indentation drops or another top-level
 *     key starts.
 *
 * Anything more exotic (flow style `packages: ["a", "b"]`, anchors,
 * merges) is not supported — pnpm itself almost universally uses the
 * block-list form.
 */
function parsePnpmWorkspacePatterns(yaml: string): string[] {
  const patterns: string[] = [];
  const lines = yaml.split(/\r?\n/);
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line) continue;

    if (/^packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    // Another top-level key (no leading whitespace + a colon) ends the
    // packages section.
    if (inPackages && /^[A-Za-z_][\w-]*\s*:/.test(line)) {
      inPackages = false;
      continue;
    }
    if (!inPackages) continue;

    const m = line.match(/^\s+-\s+(?:["']([^"']+)["']|(\S+))\s*$/);
    if (m) patterns.push(m[1] ?? m[2]!);
  }
  return patterns;
}

/**
 * Compile a workspace glob (e.g. `apps/*`) into a regex matching
 * relative paths. Supports `*` (any single path segment) and `**` (any
 * number of segments). No other glob features are needed for workspace
 * patterns in practice.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.+')
    .replace(/(?<!\.)\*/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

// ──────────────────────────────────────────────────────────────────────
// Per-ecosystem dependency manifest discovery (#203)
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk the project tree (respecting excludes) and discover
 * dependency manifests for the given ecosystem. Each manifest file
 * found gets parsed by the supplied parser, which returns a
 * normalized name → version map.
 *
 * The same walker handles all five ecosystems; only the filename
 * pattern and parser differ.
 */
function discoverDependencyManifests(
  rootDir: string,
  filenameMatchers: readonly RegExp[],
  parser: (filePath: string, contents: string) => Record<string, string> | null,
  opts: { exclude?: string[] } = {},
): DependencyManifestRecord[] {
  const excludeDirs = new Set([...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])]);
  const out: DependencyManifestRecord[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (!filenameMatchers.some((re) => re.test(entry.name))) continue;
        const text = readTextSafe(full);
        if (text == null) continue;
        const deps = parser(full, text);
        if (!deps) continue;
        const relDir = path.relative(rootDir, dir);
        out.push({
          relPath: relDir === '' ? '.' : relDir.split(path.sep).join('/'),
          source: entry.name,
          dependencies: deps,
        });
      }
    }
  };
  walk(rootDir);
  return out.sort((a, b) =>
    a.relPath === b.relPath ? a.source.localeCompare(b.source) : a.relPath.localeCompare(b.relPath),
  );
}

/** Discover Python manifests: `requirements.txt`, `pyproject.toml`, `Pipfile`. */
export function discoverPythonManifests(
  rootDir: string,
  opts: { exclude?: string[] } = {},
): DependencyManifestRecord[] {
  return discoverDependencyManifests(
    rootDir,
    [/^requirements(?:-[\w-]+)?\.txt$/i, /^pyproject\.toml$/i, /^Pipfile$/i],
    parsePythonManifest,
    opts,
  );
}

/** Discover Go manifests: `go.mod`. */
export function discoverGoManifests(
  rootDir: string,
  opts: { exclude?: string[] } = {},
): DependencyManifestRecord[] {
  return discoverDependencyManifests(rootDir, [/^go\.mod$/i], parseGoMod, opts);
}

/** Discover Java manifests: `pom.xml`, `build.gradle`, `build.gradle.kts`. */
export function discoverJavaManifests(
  rootDir: string,
  opts: { exclude?: string[] } = {},
): DependencyManifestRecord[] {
  return discoverDependencyManifests(
    rootDir,
    [/^pom\.xml$/i, /^build\.gradle(?:\.kts)?$/i],
    parseJavaManifest,
    opts,
  );
}

/** Discover PHP manifests: `composer.json`. */
export function discoverPhpManifests(
  rootDir: string,
  opts: { exclude?: string[] } = {},
): DependencyManifestRecord[] {
  return discoverDependencyManifests(rootDir, [/^composer\.json$/i], parseComposerJson, opts);
}

/** Discover Rust manifests: `Cargo.toml`. */
export function discoverRustManifests(
  rootDir: string,
  opts: { exclude?: string[] } = {},
): DependencyManifestRecord[] {
  return discoverDependencyManifests(rootDir, [/^Cargo\.toml$/i], parseCargoToml, opts);
}

// ── Per-format parsers ────────────────────────────────────────────────
//
// Each parser is intentionally minimal — it extracts dependency names
// (and best-effort versions) from the format using either the format's
// JSON parser (for composer.json) or simple regex/line-based scans.
// Goals: zero new dependencies, `~30-50` lines per parser, no false
// positives. False negatives on exotic shapes (anchors, dynamic
// expressions, multi-line continuations) are acceptable.

function parsePythonManifest(filePath: string, contents: string): Record<string, string> | null {
  if (filePath.endsWith('Pipfile')) return parsePipfile(contents);
  if (filePath.endsWith('pyproject.toml')) return parsePyprojectToml(contents);
  return parseRequirementsTxt(contents);
}

function parseRequirementsTxt(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('-')) continue; // -r, -e, --index-url, etc.
    if (line.startsWith('git+') || line.startsWith('http://') || line.startsWith('https://')) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*([<>=!~][^;]*)?/);
    if (!m) continue;
    out[m[1]!.toLowerCase()] = (m[2] ?? '').trim() || '*';
  }
  return out;
}

function parsePyprojectToml(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Extract `[project.dependencies]` AND `[tool.poetry.dependencies]` /
  // `[tool.poetry.dev-dependencies]`. Simple section scanner — strict
  // enough to skip array-of-table and nested tables we don't care about.
  let section: string | null = null;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    if (!section) continue;
    if (section !== 'tool.poetry.dependencies' && section !== 'tool.poetry.dev-dependencies') continue;
    // key = "value" OR key = { ... } — both supply a dep name as the key.
    const kvMatch = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    if (kvMatch[1] === 'python') continue; // python = ">=3.8" is the runtime constraint, not a dep
    const versionRaw = kvMatch[2]!;
    const versionMatch = versionRaw.match(/^"([^"]*)"/) ?? versionRaw.match(/version\s*=\s*"([^"]*)"/);
    out[kvMatch[1]!.toLowerCase()] = versionMatch?.[1] ?? '*';
  }
  // Also scan for the PEP 621 `[project]` table's `dependencies = ["pkg>=1"]` array.
  const projectArrMatch = contents.match(/^\[project\][\s\S]*?^dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (projectArrMatch) {
    for (const item of projectArrMatch[1]!.split(/[\n,]/)) {
      const cleaned = item.replace(/["']/g, '').trim();
      if (!cleaned) continue;
      const m = cleaned.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*([<>=!~].*)?$/);
      if (m) out[m[1]!.toLowerCase()] = (m[2] ?? '').trim() || '*';
    }
  }
  return out;
}

function parsePipfile(contents: string): Record<string, string> {
  // Pipfile is TOML; reuse the pyproject scanner with section names
  // remapped to `[packages]` / `[dev-packages]`.
  const out: Record<string, string> = {};
  let section: string | null = null;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    if (section !== 'packages' && section !== 'dev-packages') continue;
    const kvMatch = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const versionRaw = kvMatch[2]!;
    const versionMatch = versionRaw.match(/^"([^"]*)"/);
    out[kvMatch[1]!.toLowerCase()] = versionMatch?.[1] ?? '*';
  }
  return out;
}

function parseGoMod(_filePath: string, contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  // `require X version` (single line) AND `require ( ... )` block form.
  const blockMatch = contents.match(/require\s*\(([^)]*)\)/g);
  if (blockMatch) {
    for (const block of blockMatch) {
      const inner = block.replace(/^require\s*\(/, '').replace(/\)$/, '');
      for (const line of inner.split(/\r?\n/)) {
        const m = line.replace(/\/\/.*$/, '').trim().match(/^(\S+)\s+(\S+)/);
        if (m) out[m[1]!] = m[2]!;
      }
    }
  }
  for (const line of contents.split(/\r?\n/)) {
    const m = line.replace(/\/\/.*$/, '').trim().match(/^require\s+(\S+)\s+(\S+)/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function parseJavaManifest(filePath: string, contents: string): Record<string, string> {
  return filePath.endsWith('pom.xml') ? parsePomXml(contents) : parseGradleBuild(contents);
}

function parsePomXml(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  const depRx = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match: RegExpExecArray | null;
  while ((match = depRx.exec(contents)) !== null) {
    const inner = match[1]!;
    const groupId = inner.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
    const artifactId = inner.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
    const version = inner.match(/<version>([^<]+)<\/version>/)?.[1]?.trim();
    if (groupId && artifactId) {
      out[`${groupId}:${artifactId}`] = version ?? '*';
    }
  }
  return out;
}

function parseGradleBuild(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Match `implementation 'group:artifact:version'` and similar config
  // keywords (api, compileOnly, testImplementation, …). Both Groovy and
  // Kotlin DSL syntaxes are supported.
  const rx = /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor)\s*[(]?\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(contents)) !== null) {
    const coord = match[1]!;
    const parts = coord.split(':');
    if (parts.length >= 2) {
      out[`${parts[0]}:${parts[1]}`] = parts[2] ?? '*';
    }
  }
  return out;
}

function parseComposerJson(_filePath: string, contents: string): Record<string, string> | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  for (const field of ['require', 'require-dev'] as const) {
    const obj = parsed[field];
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
    }
  }
  return out;
}

function parseCargoToml(_filePath: string, contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section: string | null = null;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    if (
      section !== 'dependencies' &&
      section !== 'dev-dependencies' &&
      section !== 'build-dependencies'
    ) {
      continue;
    }
    const kvMatch = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const versionRaw = kvMatch[2]!;
    const versionMatch = versionRaw.match(/^"([^"]*)"/) ?? versionRaw.match(/version\s*=\s*"([^"]*)"/);
    out[kvMatch[1]!] = versionMatch?.[1] ?? '*';
  }
  return out;
}

/**
 * Build the `ProjectContext` for plugin auto-detection.
 *
 * Reads `package.json` from the root *and every subpackage* in the
 * tree. The synthesized `packageJson` field unions the
 * `dependencies` / `devDependencies` / `peerDependencies` across all
 * manifests so existing plugins that just check
 * `ctx.packageJson?.dependencies?.[name]` activate correctly on
 * monorepos without needing to walk subpackages themselves (#184).
 * Top-level fields (name, scripts, etc.) come from the root manifest
 * only.
 *
 * Also discovers per-ecosystem dependency manifests (#203) so non-JS
 * framework plugins can activate correctly on monorepos that keep
 * their backend deps in subpackage manifests (`apps/api/requirements.txt`,
 * `services/auth/go.mod`, etc.).
 */
export function buildProjectContext(
  rootDir: string,
  files: string[],
  opts: {
    exclude?: string[];
    workspaceRoot?: string;
    /**
     * #344 — Orchestrator-supplied pre-discoveries keyed by
     * framework-plugin id. Threaded into
     * `ProjectContext.frameworkDiscoveries` for plugins to consume.
     * Pass undefined / omit to opt out (plugins fall back to their
     * own scans).
     */
    frameworkDiscoveries?: Readonly<Record<string, readonly string[]>>;
  } = {},
): ProjectContext {
  const manifests = discoverManifests(rootDir, opts);
  const root = manifests.find((m) => m.relPath === '.')?.packageJson ?? null;
  const synthesizedPackageJson =
    manifests.length === 0 ? null : mergedPackageJson(root, manifests);
  const pythonManifests = discoverPythonManifests(rootDir, opts);
  const goManifests = discoverGoManifests(rootDir, opts);
  const javaManifests = discoverJavaManifests(rootDir, opts);
  const phpManifests = discoverPhpManifests(rootDir, opts);
  const rustManifests = discoverRustManifests(rootDir, opts);
  return {
    rootDir,
    ...(opts.workspaceRoot && opts.workspaceRoot !== rootDir
      ? { workspaceRoot: opts.workspaceRoot }
      : {}),
    packageJson: synthesizedPackageJson,
    manifests,
    pythonManifests,
    goManifests,
    javaManifests,
    phpManifests,
    rustManifests,
    files,
    ...(opts.frameworkDiscoveries !== undefined
      ? { frameworkDiscoveries: opts.frameworkDiscoveries }
      : {}),
    // Future: add requirementsTxt, goMod, pomXml, composerJson to ProjectContext
    // when those language plugins need them.
  };
}

/**
 * Synthesize a virtual root `package.json` whose
 * `dependencies` / `devDependencies` / `peerDependencies` fields are
 * the union across `manifests`. Other top-level fields (name, scripts,
 * version, …) come from `root` so non-dep introspection stays
 * predictable. Returns `null` if `manifests` is empty.
 */
function mergedPackageJson(
  root: Record<string, unknown> | null,
  manifests: readonly ManifestRecord[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = root ? { ...root } : {};
  const fields = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
  for (const field of fields) {
    const union: Record<string, unknown> = {};
    for (const m of manifests) {
      const deps = m.packageJson[field];
      if (deps && typeof deps === 'object') {
        for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
          // Subpackage-declared deps don't override a root-declared
          // version (root is conventionally the source of truth in
          // pnpm/yarn workspaces); only fill in deps the root doesn't
          // mention.
          if (!(name in union)) union[name] = version;
        }
      }
    }
    if (Object.keys(union).length > 0) merged[field] = union;
  }
  return merged;
}

/**
 * All known framework plugins. Instantiated fresh so each analysis
 * run gets its own per-project state (important for Prisma's lazy
 * visitor, which caches the system id from `onProjectLoaded`).
 */
function allPlugins(): FrameworkPlugin[] {
  return [
    new PrismaPlugin(), new MongoosePlugin(), new SupabasePlugin(), new TypeormPlugin(), new DrizzlePlugin(), new MikroOrmPlugin(), new SequelizePlugin(), new KnexPlugin(),
    new ReactPlugin(), new ExpressPlugin(), new FastifyPlugin(),
    new NestjsPlugin(), new NextjsPlugin(),
    new AxiosPlugin(), new FetchPlugin(), new RpcClientPlugin(),
    new FastapiPlugin(), new SqlalchemyPlugin(), new DjangoPlugin(), new FlaskPlugin(), new HttpxPlugin(), new GrpcioPlugin(), new AiohttpPlugin(), new CeleryPlugin(), new TornadoPlugin(), new PymongoPlugin(), new RedispyPlugin(), new Boto3Plugin(), new GcsPyPlugin(), new AzureBlobPyPlugin(), new KafkapyPlugin(), new PikaPlugin(), new WsPyPlugin(), new ElasticPyPlugin(), new MemcachePyPlugin(), new PeeweePlugin(), new TortoisePlugin(), new SqlmodelPlugin(),
    new TrpcPlugin(), new TrpcClientPlugin(), new GraphqlPlugin(), new VuePlugin(), new ReactQueryPlugin(), new SwrPlugin(),
    new KoaPlugin(), new HapiPlugin(), new HonoPlugin(), new RemixPlugin(),
    new AngularPlugin(), new SveltePlugin(), new StateMgmtPlugin(), new DomPlugin(),
    new GinPlugin(), new EchoPlugin(), new FiberPlugin(), new GoHttpPlugin(), new GrpcgoPlugin(), new GosqlxPlugin(), new ChiPlugin(), new MongogoPlugin(), new GoredisPlugin(), new AsynqPlugin(), new AwsgoS3Plugin(), new GcsGoPlugin(), new AzureBlobGoPlugin(), new KafkagoPlugin(), new WsGoPlugin(), new ElasticGoPlugin(), new MemcacheGoPlugin(), new EntPlugin(), new Amqp091GoPlugin(),
    new ActixPlugin(), new AxumPlugin(), new WarpPlugin(), new PoemPlugin(), new RocketPlugin(),
    new SpringPlugin(), new JpaPlugin(), new GormPlugin(), new LaravelPlugin(),
    new PycliPlugin(), new GocliPlugin(), new RustcliPlugin(),
    new ReactNativePlugin(),
    new ReactRouterPlugin(),
    new RedirectsPlugin(),
    new BundlerPlugin(),
    new BullmqPlugin(),
    new KafkajsPlugin(),
    new AmqplibPlugin(),
    new AwsS3TsPlugin(),
    new GcsTsPlugin(),
    new AzureBlobTsPlugin(),
    new IoredisPlugin(),
    new GrpcNodePlugin(),
    new WsTsPlugin(),
    new ElasticTsPlugin(),
    new MemcacheTsPlugin(),
    new MCPServerPlugin(),
    new SqlxPlugin(),
    new DieselPlugin(),
    new TonicPlugin(),
    new MCPServerRustPlugin(),
    new TokioSpawnPlugin(),
    new ReqwestPlugin(),
    new SeaormPlugin(),
    new MongorustPlugin(),
    new RedisrsPlugin(),
    new ApalisPlugin(),
    new AwsrustS3Plugin(),
    new GcsRsPlugin(),
    new AzureBlobRsPlugin(),
    new KafkarsPlugin(),
    new WsRsPlugin(),
    new ElasticRsPlugin(),
    new MemcacheRsPlugin(),
    new LapinPlugin(),
  ];
}

/**
 * Auto-detect which framework plugins apply to a project by calling
 * `appliesTo` on each. Returns only the plugins that match.
 *
 * Handles mutual exclusion: when react-native is detected, the generic
 * react plugin is excluded (RN plugin handles all JSX event detection
 * with correct framework attribution).
 */
export function detectPlugins(ctx: ProjectContext) {
  const matched = allPlugins().filter((p) => p.appliesTo(ctx));

  // Mutual exclusion: react-native supersedes react
  const hasReactNative = matched.some((p) => p.id === 'react-native');
  if (hasReactNative) {
    return matched.filter((p) => p.id !== 'react');
  }

  return matched;
}
