import { describe, expect, it } from 'vitest';
import { parseTableMacro } from '../table-macro.js';

describe('parseTableMacro', () => {
  it('parses a basic table with three columns', () => {
    const out = parseTableMacro(`{
      users (id) {
        id    -> BigInt,
        email -> Text,
        name  -> Nullable<Text>,
      }
    }`);
    expect(out?.name).toBe('users');
    expect(out?.columns.map((c) => c.name)).toEqual(['id', 'email', 'name']);
    expect(out?.columns.map((c) => c.sqlType)).toEqual(['BigInt', 'Text', 'Nullable<Text>']);
    expect(out?.columns.find((c) => c.name === 'id')?.isPrimaryKey).toBe(true);
    expect(out?.columns.find((c) => c.name === 'email')?.isPrimaryKey).toBe(false);
  });

  it('accepts compound primary keys', () => {
    const out = parseTableMacro(`{
      memberships (user_id, group_id) {
        user_id  -> BigInt,
        group_id -> BigInt,
        role     -> Text,
      }
    }`);
    expect(out?.name).toBe('memberships');
    const pks = out?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    expect(pks).toEqual(['user_id', 'group_id']);
    expect(out?.columns.find((c) => c.name === 'role')?.isPrimaryKey).toBe(false);
  });

  it('handles a trailing column without a comma', () => {
    const out = parseTableMacro(`{
      kvs (k) {
        k -> Text,
        v -> Text
      }
    }`);
    expect(out?.columns.map((c) => c.name)).toEqual(['k', 'v']);
  });

  it('strips use ...; preamble and #[...] attrs before parsing', () => {
    const out = parseTableMacro(`{
      use diesel::sql_types::*;
      #[sql_name = "user_accounts"]
      users (id) {
        id    -> BigInt,
        email -> Text,
      }
    }`);
    expect(out?.name).toBe('users');
    expect(out?.columns.map((c) => c.name)).toEqual(['id', 'email']);
  });

  it('returns null for an empty body', () => {
    expect(parseTableMacro('{ }')).toBeNull();
    expect(parseTableMacro('')).toBeNull();
  });

  it('returns null when the body lacks the (pk) { ... } header', () => {
    // Negative test for the PARSER layer (the visitor's
    // isDieselTableMacroPath catches a different shape — the
    // fixture's println!("audit_log (id) {...}") string is rejected
    // there, never reaches the parser).
    expect(parseTableMacro(`{
      audit_log { id -> BigInt }
    }`)).toBeNull();
  });

  it('preserves nested generic types with embedded commas', async () => {
    // Real diesel use-case: PostGIS Geography<Point, 4326>, or the
    // Numeric<Precision, Scale> shape some adapters define. The
    // earlier regex-only parser broke on the inner comma — it would
    // return sqlType = "Geography<Point" and treat "4326>" as a
    // second phantom column. Verify the bracket-aware split keeps
    // the type intact.
    const out = parseTableMacro(`{
      shapes (id) {
        id  -> BigInt,
        geo -> Geography<Point, 4326>,
        amt -> Numeric<10, 2>,
      }
    }`);
    expect(out?.columns.map((c) => c.name)).toEqual(['id', 'geo', 'amt']);
    expect(out?.columns.find((c) => c.name === 'geo')?.sqlType).toBe('Geography<Point, 4326>');
    expect(out?.columns.find((c) => c.name === 'amt')?.sqlType).toBe('Numeric<10, 2>');
  });

  it('handles a multi-line column type wrapped across newlines', async () => {
    const out = parseTableMacro(`{
      blobs (id) {
        id            -> BigInt,
        nullable_blob -> Nullable<
          Bytea
        >,
      }
    }`);
    expect(out?.columns.map((c) => c.name)).toEqual(['id', 'nullable_blob']);
    // Internal whitespace is collapsed but the type identity is
    // preserved.
    expect(out?.columns.find((c) => c.name === 'nullable_blob')?.sqlType)
      .toBe('Nullable< Bytea >');
  });
});
