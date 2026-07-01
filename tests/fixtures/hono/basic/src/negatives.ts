import { Hono, type HonoContext } from './hono-stubs.js';

// Non-canonical receiver — should NOT match.
const router = Hono();
router.get('/wont-match', (c: HonoContext) => c.text('no'));

// Unrelated .get() call.
const cache = new Map<string, string>();
cache.get('key');
