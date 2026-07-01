import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { buildIncludeRouterMap } from '../include-resolver.js';

let tmpRoot: string;

function write(rel: string, content: string): void {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fastapi-include-resolver-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildIncludeRouterMap', () => {
  describe('balanced-paren INCLUDE_CALL_RE', () => {
    it('handles a nested tuple in tags kwarg', () => {
      write(
        'main.py',
        [
          'from fastapi import FastAPI',
          'from routers import tasks',
          'app = FastAPI()',
          'app.include_router(tasks.router, prefix="/api", tags=("tasks", "v1"))',
        ].join('\n'),
      );
      write(
        'routers/tasks.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/tasks")'].join('\n'),
      );
      const { composedPrefixByRouterId } = buildIncludeRouterMap(tmpRoot);
      expect(composedPrefixByRouterId.get('router')).toBe('/api/tasks');
    });

    it('handles a nested dict in dependencies kwarg', () => {
      write(
        'main.py',
        [
          'from fastapi import FastAPI',
          'from routers import tasks',
          'app = FastAPI()',
          'app.include_router(tasks.router, prefix="/v2", dependencies={"x": 1, "y": 2})',
        ].join('\n'),
      );
      write(
        'routers/tasks.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/tasks")'].join('\n'),
      );
      const { composedPrefixByRouterId } = buildIncludeRouterMap(tmpRoot);
      expect(composedPrefixByRouterId.get('router')).toBe('/v2/tasks');
    });

    it('handles parens inside string literals', () => {
      write(
        'main.py',
        [
          'from fastapi import FastAPI',
          'from routers import tasks',
          'app = FastAPI()',
          'app.include_router(tasks.router, prefix="/api", tags=["users (legacy)"])',
        ].join('\n'),
      );
      write(
        'routers/tasks.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/tasks")'].join('\n'),
      );
      const { composedPrefixByRouterId } = buildIncludeRouterMap(tmpRoot);
      expect(composedPrefixByRouterId.get('router')).toBe('/api/tasks');
    });
  });

  describe('multiline imports', () => {
    it('handles `from x import (a, b, c)` across lines', () => {
      write(
        'main.py',
        [
          'from fastapi import FastAPI',
          'from routers import (',
          '    tasks,',
          '    users,',
          ')',
          'app = FastAPI()',
          'app.include_router(tasks.router, prefix="/api")',
          'app.include_router(users.router, prefix="/auth")',
        ].join('\n'),
      );
      write(
        'routers/tasks.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/tasks")'].join('\n'),
      );
      write(
        'routers/users.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/users")'].join('\n'),
      );
      const { composedPrefixByRouterId } = buildIncludeRouterMap(tmpRoot);
      // Both routers compose, last-write-wins on bare 'router' key.
      expect(composedPrefixByRouterId.size).toBe(1);
      const prefix = composedPrefixByRouterId.get('router');
      expect(['/api/tasks', '/auth/users']).toContain(prefix);
    });

    it('handles aliased multiline imports `import x as y`', () => {
      write(
        'main.py',
        [
          'from fastapi import FastAPI',
          'from routers import (',
          '    tasks as t,',
          ')',
          'app = FastAPI()',
          'app.include_router(t.router, prefix="/api")',
        ].join('\n'),
      );
      write(
        'routers/tasks.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/tasks")'].join('\n'),
      );
      const { composedPrefixByRouterId } = buildIncludeRouterMap(tmpRoot);
      expect(composedPrefixByRouterId.get('router')).toBe('/api/tasks');
    });
  });

  describe('relative imports', () => {
    it('resolves `from . import x` within a package', () => {
      write(
        'app/main.py',
        [
          'from fastapi import FastAPI',
          'from . import tasks',
          'app = FastAPI()',
          'app.include_router(tasks.router, prefix="/api")',
        ].join('\n'),
      );
      write(
        'app/tasks.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/tasks")'].join('\n'),
      );
      const { composedPrefixByRouterId } = buildIncludeRouterMap(tmpRoot);
      expect(composedPrefixByRouterId.get('router')).toBe('/api/tasks');
    });

    it('resolves `from .pkg import x` (single-dot with tail)', () => {
      write(
        'app/main.py',
        [
          'from fastapi import FastAPI',
          'from .routers import tasks',
          'app = FastAPI()',
          'app.include_router(tasks.router, prefix="/api")',
        ].join('\n'),
      );
      write(
        'app/routers/tasks.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/tasks")'].join('\n'),
      );
      const { composedPrefixByRouterId } = buildIncludeRouterMap(tmpRoot);
      expect(composedPrefixByRouterId.get('router')).toBe('/api/tasks');
    });

    it('resolves `from .. import x` across package levels', () => {
      write(
        'app/sub/handlers.py',
        [
          'from fastapi import FastAPI',
          'from .. import tasks',
          'app = FastAPI()',
          'app.include_router(tasks.router, prefix="/api")',
        ].join('\n'),
      );
      write(
        'app/tasks.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/tasks")'].join('\n'),
      );
      const { composedPrefixByRouterId } = buildIncludeRouterMap(tmpRoot);
      expect(composedPrefixByRouterId.get('router')).toBe('/api/tasks');
    });
  });

  describe('baseline behaviour preserved', () => {
    it('composes simple absolute-import case', () => {
      write(
        'main.py',
        [
          'from fastapi import FastAPI',
          'from routers import tasks',
          'app = FastAPI()',
          'app.include_router(tasks.router, prefix="/api")',
        ].join('\n'),
      );
      write(
        'routers/tasks.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/tasks")'].join('\n'),
      );
      const { composedPrefixByRouterId } = buildIncludeRouterMap(tmpRoot);
      expect(composedPrefixByRouterId.get('router')).toBe('/api/tasks');
    });

    it('returns empty composed prefix when no include_router exists', () => {
      write(
        'routers/tasks.py',
        ['from fastapi import APIRouter', 'router = APIRouter(prefix="/tasks")'].join('\n'),
      );
      const { composedPrefixByRouterId } = buildIncludeRouterMap(tmpRoot);
      expect(composedPrefixByRouterId.get('router')).toBe('/tasks');
    });
  });
});
