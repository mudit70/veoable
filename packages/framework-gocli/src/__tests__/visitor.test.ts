import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type ClientSideProcess, type SchemaNode } from '@veoable/schema';
import { type NodeBatch } from '@veoable/plugin-api';
import { GoLanguagePlugin } from '@veoable/lang-go';
import { GocliPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/go/cobra');

async function extract(file: string): Promise<NodeBatch> {
  const gocli = new GocliPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(gocli.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

function processes(batch: { nodes: SchemaNode[] }): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}

describe('cobra command detection', () => {
  it('detects cobra.Command{} composite literals as cli_command', async () => {
    const batch = await extract('main.go');
    const cmds = processes(batch).filter((p) => p.kind === 'cli_command');
    expect(cmds.length).toBeGreaterThanOrEqual(3);
    const names = cmds.map((p) => p.name);
    expect(names).toContain('list');
    expect(names).toContain('get');
    expect(names).toContain('create');
  });

  it('sets framework="cobra"', async () => {
    const batch = await extract('main.go');
    const cmds = processes(batch).filter((p) => p.kind === 'cli_command');
    for (const c of cmds) expect(c.framework).toBe('cobra');
  });

  it('every process passes schema validation', async () => {
    const batch = await extract('main.go');
    for (const p of processes(batch)) expect(() => validateNode(p)).not.toThrow();
  });
});

describe('main() entry point detection', () => {
  it('detects main() as script_entry', async () => {
    const batch = await extract('main.go');
    const entries = processes(batch).filter((p) => p.kind === 'script_entry');
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe('main');
    expect(entries[0].framework).toBe('go');
  });
});

describe('GocliPlugin contract', () => {
  it('has id="gocli" and language="go"', () => {
    const plugin = new GocliPlugin();
    expect(plugin.id).toBe('gocli');
    expect(plugin.language).toBe('go');
  });
});
