import { query } from './db.js';

export function getUser(id: string) {
  return query(`SELECT * FROM users WHERE id = '${id}'`);
}
