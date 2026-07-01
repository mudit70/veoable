import * as path from 'node:path';
import * as url from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { NestjsPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/nestjs/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new NestjsPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

function endpoints(batch: NodeBatch): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('NestJS controller / route detection (#16, #127)', () => {
  let batch: NodeBatch;
  beforeAll(async () => {
    batch = await extract('src/users.controller.ts');
  });

  it('composes controller-prefix + method-route into the route pattern', () => {
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`).sort();
    expect(patterns).toContain('GET /users');
    expect(patterns).toContain('GET /users/:id');
    expect(patterns).toContain('POST /users');
    expect(patterns).toContain('PATCH /users/:id');
    expect(patterns).toContain('DELETE /users/:id');
  });

  it('handles unprefixed @Controller() (root-mount) controllers', () => {
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /health');
  });

  it('emits framework=nestjs on every endpoint', () => {
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) expect(ep.framework).toBe('nestjs');
  });

  it('every emitted endpoint validates against the schema', () => {
    for (const ep of endpoints(batch)) {
      expect(() => validateNode(ep)).not.toThrow();
    }
  });

  it('extracts class-level @UseGuards into middlewareChain (applies to every method)', () => {
    // UsersController has @UseGuards(AuthGuard) at the class level.
    // Every method route must include AuthGuard.
    const usersRoutes = endpoints(batch).filter((e) => e.routePattern.startsWith('/users'));
    expect(usersRoutes.length).toBeGreaterThan(0);
    for (const ep of usersRoutes) {
      const names = (ep.middlewareChain ?? []).map((m) => m.name);
      expect(names).toContain('AuthGuard');
    }
  });

  it('extracts method-level @UseGuards in addition to class-level (POST create)', () => {
    const post = endpoints(batch).find((e) => e.httpMethod === 'POST' && e.routePattern === '/users');
    expect(post).toBeDefined();
    const names = (post!.middlewareChain ?? []).map((m) => m.name);
    expect(names).toContain('AuthGuard');
    expect(names).toContain('RoleGuard');
  });

  it('assigns a non-null handlerFunctionId composed from ClassName.methodName', () => {
    for (const ep of endpoints(batch)) {
      expect(ep.handlerFunctionId).toBeTruthy();
      expect(typeof ep.handlerFunctionId).toBe('string');
      expect(ep.handlerFunctionId!.startsWith('FunctionDefinition:')).toBe(true);
    }
  });
});

describe('NestjsPlugin.appliesTo', () => {
  it('activates on @nestjs/core dep', () => {
    const plugin = new NestjsPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { '@nestjs/core': '^10.0.0' } },
        files: [],
      }),
    ).toBe(true);
  });
  it('activates on @nestjs/common dep', () => {
    const plugin = new NestjsPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { '@nestjs/common': '^10.0.0' } },
        files: [],
      }),
    ).toBe(true);
  });
  it('does not activate without NestJS deps', () => {
    const plugin = new NestjsPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: [],
      }),
    ).toBe(false);
  });
  it('does not activate when packageJson is null', () => {
    const plugin = new NestjsPlugin();
    expect(plugin.appliesTo({ rootDir: '/x', packageJson: null, files: [] })).toBe(false);
  });
});
