import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClientSideProcess, TriggersEdge, SchemaEdge } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { createDomVisitor, DomPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/framework-dom');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(createDomVisitor());
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function processes(batch: NodeBatch): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}

function triggers(batch: NodeBatch): TriggersEdge[] {
  return batch.edges.filter(
    (e: SchemaEdge): e is TriggersEdge => e.edgeType === 'TRIGGERS',
  );
}

// ──────────────────────────────────────────────────────────────────────
// addEventListener detection
// ──────────────────────────────────────────────────────────────────────

describe('framework-dom addEventListener detection', () => {
  it('emits one ClientSideProcess per addEventListener call', async () => {
    const batch = await extract('basic', 'src/component.ts');
    // Fixture has 5 addEventListener calls (click bound, click identifier,
    // mouseenter inline, focus direct method, blur arrow-field).
    expect(processes(batch)).toHaveLength(5);
  });

  it('every emitted process has framework=dom and kind=event_handler', async () => {
    const batch = await extract('basic', 'src/component.ts');
    for (const p of processes(batch)) {
      expect(p.framework).toBe('dom');
      expect(p.kind).toBe('event_handler');
    }
  });

  it('process.name carries the event-name literal (click/mouseenter/focus/blur)', async () => {
    const batch = await extract('basic', 'src/component.ts');
    const names = processes(batch).map((p) => p.name).sort();
    expect(names).toEqual(['blur', 'click', 'click', 'focus', 'mouseenter']);
  });

  // The fixture has 5 addEventListener calls — 4 resolve to a
  // function definition (bound method, plain identifier, direct
  // method, arrow-bound field) and 1 is inline (no separate fn).
  // Exact total: 4 TRIGGERS edges, 4 DISTINCT targets.
  it('emits exactly 4 TRIGGERS edges across the fixture (one per non-inline handler)', async () => {
    const batch = await extract('basic', 'src/component.ts');
    expect(triggers(batch)).toHaveLength(4);
  });

  it('TRIGGERS edges target exactly the 4 distinct handlers (onClick, handleOverlayClick, onFocus, arrowHandler)', async () => {
    const batch = await extract('basic', 'src/component.ts');
    const trigs = triggers(batch);
    const targets = new Set(trigs.map((t) => t.to));
    expect(targets.size).toBe(4);
  });

  it('inline arrow handler emits a process but NO TRIGGERS edge', async () => {
    const batch = await extract('basic', 'src/component.ts');
    // The mouseenter listener uses an inline arrow. The process
    // count (5) exceeds the TRIGGERS count (4) by exactly that one.
    const procs = processes(batch);
    const trigs = triggers(batch);
    expect(procs.length - trigs.length).toBe(1);
    // And specifically: there's a `mouseenter` process whose id
    // does NOT appear as the `from` of any TRIGGERS edge.
    const mouseenterProc = procs.find((p) => p.name === 'mouseenter');
    expect(mouseenterProc).toBeDefined();
    expect(trigs.some((t) => t.from === mouseenterProc!.id)).toBe(false);
  });

  it('every non-inline event has a corresponding TRIGGERS from its process to a function', async () => {
    const batch = await extract('basic', 'src/component.ts');
    const procs = processes(batch);
    const trigs = triggers(batch);
    // For each event name in the fixture EXCEPT mouseenter, the
    // process must originate a TRIGGERS edge.
    const triggeringEvents = procs
      .filter((p) => trigs.some((t) => t.from === p.id))
      .map((p) => p.name)
      .sort();
    expect(triggeringEvents).toEqual(['blur', 'click', 'click', 'focus']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// DomPlugin.appliesTo
// ──────────────────────────────────────────────────────────────────────

describe('DomPlugin.appliesTo', () => {
  it('activates when a browser-runtime dependency is declared', () => {
    const plugin = new DomPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { react: '^18.0.0' } },
        files: [],
      }),
    ).toBe(true);
  });

  it('activates when no browser- AND no server-runtime dependency is declared (vanilla case)', () => {
    const plugin = new DomPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { typescript: '^5.0.0' } },
        files: [],
      }),
    ).toBe(true);
  });

  it('does NOT activate on a pure backend project (express/fastify/nest)', () => {
    const plugin = new DomPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: [],
      }),
    ).toBe(false);
  });

  it('activates when both browser AND server runtimes are present (full-stack monorepo)', () => {
    const plugin = new DomPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: {
          dependencies: { react: '^18.0.0', express: '^4.0.0' },
        },
        files: [],
      }),
    ).toBe(true);
  });

  it('handles missing packageJson gracefully', () => {
    const plugin = new DomPlugin();
    expect(
      plugin.appliesTo({ rootDir: '/nowhere', packageJson: null, files: [] }),
    ).toBe(true);
  });
});
