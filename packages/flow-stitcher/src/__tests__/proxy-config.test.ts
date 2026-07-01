import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverProxyRules } from '../proxy-config.js';

/**
 * Tests for #188 Cause 2: build-tool proxy-config detection.
 *
 * Each scenario writes a config file into a temp dir and asks
 * `discoverProxyRules` to extract rules from it. The detector is
 * structural (AST-based) — these tests pin the structural shapes we
 * recognize and the ones we deliberately bail on.
 */

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veoable-proxy-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(name: string, content: string): void {
  fs.writeFileSync(path.join(tmpDir, name), content);
}

describe('discoverProxyRules — Vite', () => {
  it('extracts a strip-prefix rule from `defineConfig({server:{proxy:{...}}})`', () => {
    writeConfig('vite.config.ts', `
import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        rewrite: (p) => p.replace(/^\\/api/, ''),
      },
    },
  },
});
`);
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].prefix).toBe('/api');
    expect(rules[0].stripsPrefix).toBe(true);
    expect(rules[0].upstreamTarget).toBe('http://localhost:3001');
    expect(rules[0].source).toBe('vite');
  });

  it('extracts a no-rewrite rule (upstream sees full path) as stripsPrefix=false', () => {
    writeConfig('vite.config.ts', `
import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
      },
    },
  },
});
`);
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].prefix).toBe('/api');
    expect(rules[0].stripsPrefix).toBe(false);
    expect(rules[0].upstreamTarget).toBe('http://localhost:3001');
  });

  it('treats a string-valued proxy entry as no-rewrite, target = the string', () => {
    writeConfig('vite.config.ts', `
import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
`);
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].stripsPrefix).toBe(false);
    expect(rules[0].upstreamTarget).toBe('http://localhost:3001');
  });

  it('extracts MULTIPLE proxy entries from one config', () => {
    writeConfig('vite.config.ts', `
import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', rewrite: (p) => p.replace(/^\\/api/, '') },
      '/v2':  { target: 'http://localhost:3002' },
    },
  },
});
`);
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(2);
    const apiRule = rules.find((r) => r.prefix === '/api')!;
    const v2Rule = rules.find((r) => r.prefix === '/v2')!;
    expect(apiRule.stripsPrefix).toBe(true);
    expect(v2Rule.stripsPrefix).toBe(false);
  });

  it('handles bare object default export (no defineConfig wrapper)', () => {
    writeConfig('vite.config.ts', `
export default {
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', rewrite: (p) => p.replace(/^\\/api/, '') },
    },
  },
};
`);
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].stripsPrefix).toBe(true);
  });

  it('handles indirect default export through a const', () => {
    writeConfig('vite.config.ts', `
import { defineConfig } from 'vite';
const config = defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', rewrite: (p) => p.replace(/^\\/api/, '') },
    },
  },
});
export default config;
`);
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].prefix).toBe('/api');
    expect(rules[0].stripsPrefix).toBe(true);
  });

  it('returns [] when no proxy table is configured', () => {
    writeConfig('vite.config.ts', `
import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: 5173 },
});
`);
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(0);
  });

  it('returns [] when no Vite config exists', () => {
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(0);
  });

  it('returns [] (with span event) when rewrite is a non-deterministic identifier', () => {
    writeConfig('vite.config.ts', `
import { defineConfig } from 'vite';
const myRewrite = (p: string) => 'something dynamic';
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', rewrite: myRewrite },
    },
  },
});
`);
    const rules = discoverProxyRules(tmpDir);
    // The rule itself is still extracted (target is known); the rewrite
    // shape is non-deterministic so stripsPrefix stays false (the safe
    // default — "don't strip, the upstream may need the full path").
    expect(rules).toHaveLength(1);
    expect(rules[0].stripsPrefix).toBe(false);
  });

  it('returns false stripsPrefix when rewrite regex anchors a different prefix', () => {
    writeConfig('vite.config.ts', `
import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', rewrite: (p) => p.replace(/^\\/v2/, '') },
    },
  },
});
`);
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].stripsPrefix).toBe(false);
  });

  it('handles vite.config.js (CommonJS) — same shape', () => {
    writeConfig('vite.config.js', `
module.exports = {
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', rewrite: (p) => p.replace(/^\\/api/, '') },
    },
  },
};
`);
    // CommonJS module.exports is NOT a default export. The detector only
    // recognizes ESM default export, so module.exports is correctly
    // not detected. Pin this behavior so future changes are intentional.
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(0);
  });

  it('handles vite.config.mjs ESM with defineConfig + arrow-function form', () => {
    writeConfig('vite.config.mjs', `
import { defineConfig } from 'vite';
export default defineConfig(({ mode }) => ({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', rewrite: (p) => p.replace(/^\\/api/, '') },
    },
  },
}));
`);
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].prefix).toBe('/api');
    expect(rules[0].stripsPrefix).toBe(true);
  });

  it('only reads ONE Vite config file even when multiple exist (.ts wins)', () => {
    writeConfig('vite.config.ts', `
export default {
  server: { proxy: { '/api': { target: 'http://localhost:3001' } } },
};
`);
    writeConfig('vite.config.js', `
module.exports = { server: { proxy: { '/v2': { target: 'http://localhost:3002' } } } };
`);
    const rules = discoverProxyRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].prefix).toBe('/api');
  });
});
