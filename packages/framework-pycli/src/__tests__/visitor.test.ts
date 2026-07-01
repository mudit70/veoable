import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type ClientSideProcess, type SchemaNode } from '@adorable/schema';
import { type NodeBatch } from '@adorable/plugin-api';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { PycliPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/python/cli');

async function extract(file: string): Promise<NodeBatch> {
  const pycli = new PycliPlugin();
  const py = new PyLanguagePlugin();
  py.registerVisitor(pycli.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

function processes(batch: { nodes: SchemaNode[] }): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}

describe('click CLI command detection', () => {
  it('detects @cli.command() decorated functions as cli_command', async () => {
    const batch = await extract('click_app.py');
    const procs = processes(batch);
    const cmds = procs.filter((p) => p.kind === 'cli_command');
    expect(cmds.length).toBeGreaterThanOrEqual(2);
    const names = cmds.map((p) => p.name);
    expect(names).toContain('list_items');
    expect(names).toContain('get_item');
  });

  it('sets framework="click"', async () => {
    const batch = await extract('click_app.py');
    const cmds = processes(batch).filter((p) => p.kind === 'cli_command');
    for (const c of cmds) expect(c.framework).toBe('click');
  });

  it('every process passes schema validation', async () => {
    const batch = await extract('click_app.py');
    for (const p of processes(batch)) expect(() => validateNode(p)).not.toThrow();
  });
});

describe('script entry point detection', () => {
  it('detects if __name__ == __main__ as script_entry', async () => {
    const batch = await extract('click_app.py');
    const procs = processes(batch);
    const entries = procs.filter((p) => p.kind === 'script_entry');
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe('__main__');
  });

  it('detects __main__ in plain scripts', async () => {
    const batch = await extract('script_app.py');
    const entries = processes(batch).filter((p) => p.kind === 'script_entry');
    expect(entries.length).toBe(1);
  });
});

describe('PycliPlugin contract', () => {
  it('has id="pycli" and language="py"', () => {
    const plugin = new PycliPlugin();
    expect(plugin.id).toBe('pycli');
    expect(plugin.language).toBe('py');
  });
});
