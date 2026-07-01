import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type ClientSideProcess, type SchemaNode } from '@veoable/schema';
import { type NodeBatch } from '@veoable/plugin-api';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { RustcliPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLAP_FIXTURE = path.resolve(__dirname, '../../../../tests/fixtures/rust/clap');
const TAURI_FIXTURE = path.resolve(__dirname, '../../../../tests/fixtures/rust/tauri');

async function extractFrom(root: string, file: string): Promise<NodeBatch> {
  const rustcli = new RustcliPlugin();
  const rust = new RustLanguagePlugin();
  rust.registerVisitor(rustcli.visitor);
  const handle = await rust.loadProject({ rootDir: root });
  return rust.extractFile(handle, file);
}

function processes(batch: { nodes: SchemaNode[] }): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}

describe('tauri command detection', () => {
  it('detects #[tauri::command] as bridge_command', async () => {
    const batch = await extractFrom(TAURI_FIXTURE, 'commands.rs');
    const cmds = processes(batch).filter((p) => p.kind === 'bridge_command');
    expect(cmds.length).toBeGreaterThanOrEqual(2);
    const names = cmds.map((p) => p.name);
    expect(names).toContain('get_users');
    expect(names).toContain('create_user');
  });

  it('sets framework="tauri"', async () => {
    const batch = await extractFrom(TAURI_FIXTURE, 'commands.rs');
    const cmds = processes(batch).filter((p) => p.kind === 'bridge_command');
    for (const c of cmds) expect(c.framework).toBe('tauri');
  });

  it('every process passes schema validation', async () => {
    const batch = await extractFrom(TAURI_FIXTURE, 'commands.rs');
    for (const p of processes(batch)) expect(() => validateNode(p)).not.toThrow();
  });
});

describe('main() entry point detection', () => {
  it('detects main() in Clap apps as script_entry', async () => {
    const batch = await extractFrom(CLAP_FIXTURE, 'main.rs');
    const entries = processes(batch).filter((p) => p.kind === 'script_entry');
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe('main');
    expect(entries[0].framework).toBe('rust');
  });
});

describe('RustcliPlugin contract', () => {
  it('has id="rustcli" and language="rust"', () => {
    const plugin = new RustcliPlugin();
    expect(plugin.id).toBe('rustcli');
    expect(plugin.language).toBe('rust');
  });
});
