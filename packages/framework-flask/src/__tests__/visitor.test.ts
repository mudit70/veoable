import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { FlaskPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/python/flask/basic');

async function extract(file: string): Promise<NodeBatch> {
  const flask = new FlaskPlugin();
  const py = new PyLanguagePlugin();
  py.registerVisitor(flask.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('Flask route detection', () => {
  it('detects @app.route + @app.get + @app.route(methods=...)', async () => {
    const batch = await extract('main.py');
    const eps = endpoints(batch);
    const patterns = eps.map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /health');
    expect(patterns).toContain('GET /version');
    expect(patterns).toContain('POST /login');
  });

  it('framework is "flask" on every emitted endpoint', async () => {
    const batch = await extract('main.py');
    for (const ep of endpoints(batch)) {
      expect(ep.framework).toBe('flask');
    }
  });

  it('every endpoint passes canonical schema validation', async () => {
    const batch = await extract('main.py');
    for (const ep of endpoints(batch)) {
      expect(() => validateNode(ep)).not.toThrow();
    }
  });
});

describe('Flask blueprint prefix composition (#204)', () => {
  it('composes blueprint url_prefix only when register_blueprint is absent', async () => {
    const batch = await extract('blueprint_only.py');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /items/:id');
    expect(patterns).toContain('DELETE /items/:id');
    // No /api prefix anywhere — register_blueprint not in this file.
    for (const p of patterns) expect(p).not.toMatch(/\s\/api/);
  });

  it('composes register_blueprint(url_prefix) + Blueprint(url_prefix) + route inline', async () => {
    const batch = await extract('blueprint_inline.py');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    // bp = Blueprint(..., url_prefix='/users'); register_blueprint(bp, url_prefix='/api')
    // → /api/users/<int:id>
    expect(patterns).toContain('GET /api/users/:id');
    expect(patterns).toContain('GET /api/users/:id/posts');
    expect(patterns).toContain('GET /api/users/');
    expect(patterns).toContain('POST /api/users/');
    // App-level route is NOT affected by the register_blueprint.
    expect(patterns).toContain('GET /version');
  });
});

describe('Flask plugin contract', () => {
  it('has id="flask" and language="py"', () => {
    const plugin = new FlaskPlugin();
    expect(plugin.id).toBe('flask');
    expect(plugin.language).toBe('py');
  });
});
