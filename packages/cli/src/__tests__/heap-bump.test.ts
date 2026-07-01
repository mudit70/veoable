import { describe, expect, it } from 'vitest';
import { decideHeapBump } from '../heap-bump.js';

/**
 * Decision-table tests for the V8 heap-bump trigger (#181). The
 * actual respawn is integration-tested by running the CLI; here we
 * pin every reason the bump should or should not fire.
 */
describe('decideHeapBump', () => {
  const CLI_ENTRY = '/usr/local/lib/node_modules/.bin/veoable';
  const CLI_DIST = '/Users/x/proj/veoable/packages/cli/dist/cli.js';
  const NOT_CLI = '/Users/x/proj/veoable/packages/cli/src/__tests__/heap-bump.test.ts';

  it('respawns when entry is the linked veoable binary and no heap flag is set', () => {
    const d = decideHeapBump({}, [], ['node', CLI_ENTRY, 'analyze', './x']);
    expect(d.shouldRespawn).toBe(true);
    expect(d.heapMb).toBe(8192);
  });

  it('respawns when entry is dist/cli.js (direct invocation) and no heap flag is set', () => {
    const d = decideHeapBump({}, [], ['node', CLI_DIST, 'analyze', './x']);
    expect(d.shouldRespawn).toBe(true);
  });

  it('does NOT respawn when invoked programmatically (entry is a test file)', () => {
    const d = decideHeapBump({}, [], ['node', NOT_CLI]);
    expect(d.shouldRespawn).toBe(false);
    expect(d.reason).toMatch(/not running as CLI entry point/);
  });

  it('does NOT respawn when execArgv already specifies --max-old-space-size', () => {
    const d = decideHeapBump({}, ['--max-old-space-size=16384'], ['node', CLI_ENTRY]);
    expect(d.shouldRespawn).toBe(false);
    expect(d.reason).toMatch(/execArgv/);
  });

  it('does NOT respawn when NODE_OPTIONS contains --max-old-space-size', () => {
    const d = decideHeapBump(
      { NODE_OPTIONS: '--max-old-space-size=4096 --enable-source-maps' },
      [],
      ['node', CLI_ENTRY],
    );
    expect(d.shouldRespawn).toBe(false);
    expect(d.reason).toMatch(/NODE_OPTIONS/);
  });

  it('does NOT respawn when ADORABLE_NO_HEAP_BUMP=1', () => {
    const d = decideHeapBump({ ADORABLE_NO_HEAP_BUMP: '1' }, [], ['node', CLI_ENTRY]);
    expect(d.shouldRespawn).toBe(false);
    expect(d.reason).toMatch(/ADORABLE_NO_HEAP_BUMP/);
  });

  it('honors ADORABLE_HEAP_MB to override the default heap budget', () => {
    const d = decideHeapBump(
      { ADORABLE_HEAP_MB: '12288' },
      [],
      ['node', CLI_ENTRY, 'analyze'],
    );
    expect(d.shouldRespawn).toBe(true);
    expect(d.heapMb).toBe(12288);
  });

  it('falls back to 8192 MB when ADORABLE_HEAP_MB is invalid', () => {
    const d = decideHeapBump(
      { ADORABLE_HEAP_MB: 'not-a-number' },
      [],
      ['node', CLI_ENTRY, 'analyze'],
    );
    expect(d.heapMb).toBe(8192);
  });

  it('falls back to 8192 MB when ADORABLE_HEAP_MB is zero or negative', () => {
    expect(decideHeapBump({ ADORABLE_HEAP_MB: '0' }, [], ['node', CLI_ENTRY]).heapMb).toBe(8192);
    expect(decideHeapBump({ ADORABLE_HEAP_MB: '-1' }, [], ['node', CLI_ENTRY]).heapMb).toBe(8192);
  });

  it('matches the binary on Windows path separators', () => {
    const d = decideHeapBump({}, [], ['node', 'C:\\Users\\x\\node_modules\\.bin\\veoable']);
    expect(d.shouldRespawn).toBe(true);
  });

  it('does not match a path that merely contains "cli.js" as a substring of a longer name', () => {
    // A test fixture or unrelated script that happens to have "cli.js"
    // in its name shouldn't trigger the respawn.
    const d = decideHeapBump({}, [], ['node', '/proj/foo/cli.js.bak']);
    expect(d.shouldRespawn).toBe(false);
  });

  it('still returns a sensible decision when argv has no entry', () => {
    const d = decideHeapBump({}, [], ['node']);
    expect(d.shouldRespawn).toBe(false);
  });
});
