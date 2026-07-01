import { type HonoContext } from './hono-stubs.js';

export function getHealth(c: HonoContext) {
  return c.json({ status: 'ok' });
}
