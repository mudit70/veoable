import { describe, expect, it } from 'vitest';
import { extractFirstTableOp } from '../sql-parse.js';

describe('extractFirstTableOp', () => {
  it('SELECT ... FROM users → read users', () => {
    expect(extractFirstTableOp('SELECT id, name FROM users WHERE id = $1'))
      .toEqual({ table: 'users', operation: 'read' });
  });

  it('INSERT INTO orders → insert orders', () => {
    expect(extractFirstTableOp('INSERT INTO orders (user_id, total) VALUES ($1, $2)'))
      .toEqual({ table: 'orders', operation: 'insert' });
  });

  it('UPDATE users SET ... → update users', () => {
    expect(extractFirstTableOp('UPDATE users SET email = $1 WHERE id = $2'))
      .toEqual({ table: 'users', operation: 'update' });
  });

  it('DELETE FROM carts → delete carts', () => {
    expect(extractFirstTableOp('DELETE FROM carts WHERE updated_at < NOW()'))
      .toEqual({ table: 'carts', operation: 'delete' });
  });

  it('strips schema-qualified prefixes (public.users → users)', () => {
    expect(extractFirstTableOp('SELECT * FROM public.users'))
      .toEqual({ table: 'users', operation: 'read' });
    expect(extractFirstTableOp('UPDATE public.orders SET status = $1'))
      .toEqual({ table: 'orders', operation: 'update' });
  });

  it('handles multi-line SQL across the SELECT...FROM gap', () => {
    expect(extractFirstTableOp(`
      SELECT
        id,
        email,
        created_at
      FROM users
      WHERE id = $1
    `)).toEqual({ table: 'users', operation: 'read' });
  });

  it('case-insensitive on the verb', () => {
    expect(extractFirstTableOp('select * from users')).toEqual({ table: 'users', operation: 'read' });
    expect(extractFirstTableOp('Insert Into Orders Values ($1)')).toEqual({ table: 'Orders', operation: 'insert' });
  });

  it('ignores -- line comments that contain a fake verb', () => {
    // The comment line should not trip the delete regex.
    const sql = `-- DELETE FROM users -- noop\nSELECT id FROM users`;
    expect(extractFirstTableOp(sql)).toEqual({ table: 'users', operation: 'read' });
  });

  it('ignores /* block */ comments', () => {
    const sql = `/* DELETE FROM users (joke) */ SELECT id FROM accounts`;
    expect(extractFirstTableOp(sql)).toEqual({ table: 'accounts', operation: 'read' });
  });

  it('returns null for DDL with no recognized DML verb (CREATE TABLE)', () => {
    expect(extractFirstTableOp('CREATE TABLE foo (id BIGSERIAL)')).toBeNull();
    expect(extractFirstTableOp('ALTER TABLE users ADD COLUMN x INT')).toBeNull();
  });

  it('returns null for empty / whitespace-only SQL', () => {
    expect(extractFirstTableOp('')).toBeNull();
    expect(extractFirstTableOp('   \n\t  ')).toBeNull();
  });
});
