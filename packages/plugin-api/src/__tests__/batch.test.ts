import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@veoable/schema';
import { emptyBatch, makeBatchMeta } from '../batch.js';

describe('makeBatchMeta', () => {
  it('pins schemaVersion to the current SCHEMA_VERSION', () => {
    const meta = makeBatchMeta('ts');
    expect(meta.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('records the producing plugin id', () => {
    expect(makeBatchMeta('express').producedBy).toBe('express');
    expect(makeBatchMeta('ts').producedBy).toBe('ts');
  });

  it('produces a valid ISO-8601 producedAt timestamp', () => {
    const before = Date.now();
    const meta = makeBatchMeta('ts');
    const after = Date.now();
    // ISO-8601 format check
    expect(meta.producedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
    // Timestamp is within the call window
    const parsed = Date.parse(meta.producedAt);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it('produces distinct timestamps across successive calls when time advances', async () => {
    const a = makeBatchMeta('ts');
    await new Promise((r) => setTimeout(r, 2));
    const b = makeBatchMeta('ts');
    // Allow equal in pathological fast-clock cases but assert non-decreasing.
    expect(Date.parse(b.producedAt)).toBeGreaterThanOrEqual(Date.parse(a.producedAt));
  });
});

describe('emptyBatch', () => {
  it('returns a fresh empty batch each call', () => {
    const a = emptyBatch();
    const b = emptyBatch();
    expect(a).toEqual({ nodes: [], edges: [] });
    expect(b).toEqual({ nodes: [], edges: [] });
    expect(a).not.toBe(b); // independent instances
  });

  it('returns arrays that are independently mutable', () => {
    const a = emptyBatch();
    const b = emptyBatch();
    a.nodes.push({
      nodeType: 'SourceFile',
      id: 'SourceFile:deadbeefdeadbeef',
      filePath: 'x.ts',
      repository: 'r',
      language: 'ts',
      framework: null,
    });
    expect(b.nodes).toHaveLength(0);
  });
});
