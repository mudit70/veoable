import { describe, expect, it } from 'vitest';
import { hasCrateImport, isImportedFromCrate, scanCrateImports, type CrateImports } from '../use-scanner.js';

// scanCrateImports / hasCrateImport only touch `childCount` + `child(i)`
// and each child's `type` + `text`. Faking that interface here avoids
// pulling tree-sitter-rust into the unit test layer.
function fakeRoot(useDeclarations: string[]): {
  childCount: number;
  child: (i: number) => { type: string; text: string } | null;
} {
  return {
    childCount: useDeclarations.length,
    child: (i: number) => ({ type: 'use_declaration', text: useDeclarations[i] }),
  };
}

describe('scanCrateImports', () => {
  it('returns an empty index for a file with no matching imports', () => {
    const out = scanCrateImports(fakeRoot([
      'use std::collections::HashMap;',
      'use serde::Serialize;',
    ]) as any, 'diesel');
    expect([...out.names]).toEqual([]);
    expect(out.hasGlob).toBe(false);
  });

  it('captures `use <crate>::single;` single imports', () => {
    const out = scanCrateImports(fakeRoot([
      'use diesel::insert_into;',
    ]) as any, 'diesel');
    expect([...out.names]).toEqual(['insert_into']);
    expect(out.hasGlob).toBe(false);
  });

  it('captures `use <crate>::{a, b, c};` flat group imports', () => {
    const out = scanCrateImports(fakeRoot([
      'use diesel::{insert_into, update, delete};',
    ]) as any, 'diesel');
    expect([...out.names].sort()).toEqual(['delete', 'insert_into', 'update']);
  });

  it('treats `use <crate>::*;` as a glob (every name in scope)', () => {
    const out = scanCrateImports(fakeRoot([
      'use diesel::*;',
    ]) as any, 'diesel');
    expect(out.hasGlob).toBe(true);
  });

  it('treats `use <crate>::prelude::*;` as a glob', () => {
    const out = scanCrateImports(fakeRoot([
      'use diesel::prelude::*;',
    ]) as any, 'diesel');
    expect(out.hasGlob).toBe(true);
  });

  it('drops aliased members (`a as x`) from group imports', () => {
    const out = scanCrateImports(fakeRoot([
      'use diesel::{insert_into as ins, update};',
    ]) as any, 'diesel');
    expect([...out.names]).toEqual(['update']);
  });

  it('combines a glob with explicit names cleanly', () => {
    const out = scanCrateImports(fakeRoot([
      'use diesel::prelude::*;',
      'use diesel::sql_types::*;',
      'use diesel::insert_into;',
    ]) as any, 'diesel');
    expect(out.hasGlob).toBe(true);
    expect(out.names.has('insert_into')).toBe(true);
  });

  it('ignores use declarations from other crates', () => {
    const out = scanCrateImports(fakeRoot([
      'use std::collections::HashMap;',
      'use diesel::insert_into;',
      'use serde::{Serialize, Deserialize};',
    ]) as any, 'diesel');
    expect([...out.names]).toEqual(['insert_into']);
  });

  it('parameterizes on the crate name (works for tonic)', () => {
    const out = scanCrateImports(fakeRoot([
      'use tonic::async_trait;',
      'use tonic::{Request, Response};',
      'use diesel::insert_into;',  // unrelated
    ]) as any, 'tonic');
    expect([...out.names].sort()).toEqual(['Request', 'Response', 'async_trait']);
  });

  it('does not match a crate whose name is a prefix of another', () => {
    // `use diesel_cli::foo;` must NOT pollute the `diesel` index.
    const out = scanCrateImports(fakeRoot([
      'use diesel_cli::foo;',
    ]) as any, 'diesel');
    expect([...out.names]).toEqual([]);
    expect(out.hasGlob).toBe(false);
  });
});

describe('isImportedFromCrate', () => {
  const empty: CrateImports = { names: new Set(), hasGlob: false };
  const explicit: CrateImports = { names: new Set(['insert_into', 'update']), hasGlob: false };
  const glob: CrateImports = { names: new Set(), hasGlob: true };

  it('returns false when nothing is imported', () => {
    expect(isImportedFromCrate(empty, 'insert_into')).toBe(false);
  });

  it('returns true for an explicit by-name import', () => {
    expect(isImportedFromCrate(explicit, 'insert_into')).toBe(true);
  });

  it('returns false for a name not in the explicit set', () => {
    expect(isImportedFromCrate(explicit, 'delete')).toBe(false);
  });

  it('returns true for ANY name when a glob is in scope', () => {
    expect(isImportedFromCrate(glob, 'insert_into')).toBe(true);
    expect(isImportedFromCrate(glob, 'delete')).toBe(true);
  });
});

describe('hasCrateImport', () => {
  it('returns true when any use_declaration mentions the crate', () => {
    expect(hasCrateImport(fakeRoot([
      'use std::collections::HashMap;',
      'use axum::Router;',
    ]) as any, 'axum')).toBe(true);
  });

  it('returns false when no use_declaration mentions the crate', () => {
    expect(hasCrateImport(fakeRoot([
      'use std::collections::HashMap;',
      'use serde::Serialize;',
    ]) as any, 'axum')).toBe(false);
  });

  it('returns false when there are no use_declarations at all', () => {
    expect(hasCrateImport(fakeRoot([]) as any, 'axum')).toBe(false);
  });
});
