/**
 * Shared test runner for endpoint detection fixtures (#32).
 *
 * Loads a fixture directory, runs the appropriate language + framework
 * plugin, and returns detected endpoints for comparison.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type NodeBatch, type LanguagePlugin, type FrameworkPlugin } from '@adorable/plugin-api';
import { type APIEndpoint, type SchemaNode, validateNode } from '@adorable/schema';
import type { ExpectedDetectionResult, ExpectedEndpoint } from './types.js';

// Language plugin factories
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { JavaLanguagePlugin } from '@adorable/lang-java';
import { PhpLanguagePlugin } from '@adorable/lang-php';
import { RustLanguagePlugin } from '@adorable/lang-rust';

// Framework plugin factories
import { ExpressPlugin } from '@adorable/framework-express';
import { FastifyPlugin } from '@adorable/framework-fastify';
import { NestjsPlugin } from '@adorable/framework-nestjs';
import { NextjsPlugin } from '@adorable/framework-nextjs';
import { KoaPlugin } from '@adorable/framework-koa';
import { HapiPlugin } from '@adorable/framework-hapi';
import { HonoPlugin } from '@adorable/framework-hono';
import { RemixPlugin } from '@adorable/framework-remix';
import { FastapiPlugin } from '@adorable/framework-fastapi';
import { FlaskPlugin } from '@adorable/framework-flask';
import { DjangoPlugin } from '@adorable/framework-django';
import { GinPlugin } from '@adorable/framework-gin';
import { GoHttpPlugin } from '@adorable/framework-gohttp';
import { ActixPlugin } from '@adorable/framework-actix';
import { AxumPlugin } from '@adorable/framework-axum';
import { RocketPlugin } from '@adorable/framework-rocket';
import { SpringPlugin } from '@adorable/framework-spring';
import { LaravelPlugin } from '@adorable/framework-laravel';
import { TrpcPlugin } from '@adorable/framework-trpc';
import { GraphqlPlugin } from '@adorable/framework-graphql';

const LANGUAGE_PLUGINS: Record<string, () => LanguagePlugin> = {
  ts: () => new TsLanguagePlugin(),
  py: () => new PyLanguagePlugin(),
  go: () => new GoLanguagePlugin(),
  java: () => new JavaLanguagePlugin(),
  php: () => new PhpLanguagePlugin(),
  rust: () => new RustLanguagePlugin(),
};

const FRAMEWORK_PLUGINS: Record<string, () => FrameworkPlugin> = {
  express: () => new ExpressPlugin(),
  fastify: () => new FastifyPlugin(),
  nestjs: () => new NestjsPlugin(),
  nextjs: () => new NextjsPlugin(),
  koa: () => new KoaPlugin(),
  hapi: () => new HapiPlugin(),
  hono: () => new HonoPlugin(),
  remix: () => new RemixPlugin(),
  fastapi: () => new FastapiPlugin(),
  flask: () => new FlaskPlugin(),
  django: () => new DjangoPlugin(),
  gin: () => new GinPlugin(),
  gohttp: () => new GoHttpPlugin(),
  actix: () => new ActixPlugin(),
  axum: () => new AxumPlugin(),
  rocket: () => new RocketPlugin(),
  spring: () => new SpringPlugin(),
  laravel: () => new LaravelPlugin(),
  trpc: () => new TrpcPlugin(),
  graphql: () => new GraphqlPlugin(),
};

/** Language-specific file extensions (M2 fix: no cross-language .tsx/.jsx) */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  ts: ['.ts', '.tsx', '.js', '.jsx'],
  py: ['.py'],
  go: ['.go'],
  java: ['.java'],
  php: ['.php'],
  rust: ['.rs'],
};

/**
 * Load and run a fixture, returning detected endpoints.
 */
export async function runFixture(fixtureDir: string): Promise<{
  endpoints: APIEndpoint[];
  expected: ExpectedDetectionResult;
}> {
  const expectedPath = path.join(fixtureDir, 'expected.json');
  const inputDir = path.join(fixtureDir, 'input');

  const expected: ExpectedDetectionResult = JSON.parse(
    fs.readFileSync(expectedPath, 'utf-8')
  );

  const langFactory = LANGUAGE_PLUGINS[expected.language];
  const fwFactory = FRAMEWORK_PLUGINS[expected.pluginId];
  if (!langFactory) throw new Error(`Unknown language: ${expected.language}`);
  if (!fwFactory) throw new Error(`Unknown plugin: ${expected.pluginId}`);

  const langPlugin = langFactory();
  const fwPlugin = fwFactory();
  langPlugin.registerVisitor(fwPlugin.visitor);

  const handle = await langPlugin.loadProject({ rootDir: inputDir });

  // M2 fix: only discover files matching the fixture's language
  const extensions = LANGUAGE_EXTENSIONS[expected.language] ?? ['.ts'];
  const files = discoverFiles(inputDir, extensions);

  const allNodes: SchemaNode[] = [];
  for (const file of files) {
    const batch: NodeBatch = await langPlugin.extractFile(handle, file);
    allNodes.push(...batch.nodes);
  }

  const endpoints = allNodes.filter(
    (n): n is APIEndpoint => n.nodeType === 'APIEndpoint'
  );

  return { endpoints, expected };
}

/**
 * Assert that detected endpoints match expected endpoints bidirectionally.
 * M1 fix: checks both directions — no missing AND no spurious endpoints.
 */
export function assertEndpointsMatch(
  actual: APIEndpoint[],
  expected: ExpectedEndpoint[],
): void {
  const actualPatterns = actual.map((e) => `${e.httpMethod} ${e.routePattern}`).sort();
  const expectedPatterns = expected.map((e) => `${e.httpMethod} ${e.routePattern}`).sort();

  // Check: every expected endpoint is in actual
  for (const exp of expectedPatterns) {
    if (!actualPatterns.includes(exp)) {
      throw new Error(
        `Missing expected endpoint: ${exp}\n` +
        `Actual: [${actualPatterns.join(', ')}]`
      );
    }
  }

  // M1 fix: check for spurious endpoints (actual not in expected)
  for (const act of actualPatterns) {
    if (!expectedPatterns.includes(act)) {
      throw new Error(
        `Unexpected extra endpoint detected: ${act}\n` +
        `Expected: [${expectedPatterns.join(', ')}]`
      );
    }
  }
}

/**
 * Assert that no negative patterns were detected.
 */
export function assertNoNegatives(
  actual: APIEndpoint[],
  negativePatterns: string[],
): void {
  const actualPatterns = actual.map((e) => `${e.httpMethod} ${e.routePattern}`);
  for (const neg of negativePatterns) {
    if (actualPatterns.some((p) => p.includes(neg))) {
      throw new Error(`Unexpected negative endpoint detected: ${neg}`);
    }
  }
}

/**
 * Assert all endpoints pass schema validation.
 */
export function assertSchemaValid(endpoints: APIEndpoint[]): void {
  for (const ep of endpoints) {
    validateNode(ep);
  }
}

function discoverFiles(dir: string, extensions: string[]): string[] {
  const files: string[] = [];
  function walk(d: string, prefix: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(d, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        files.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }
  walk(dir, '');
  return files.sort();
}
