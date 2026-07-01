import { Router, type KoaContext } from './koa-stubs.js';

// Non-canonical receiver — should NOT match.
const api = Router();
api.get('/wont-match', (ctx: KoaContext) => { ctx.body = 'no'; });

// Unrelated .get() call on a map-like object.
const cache = new Map<string, string>();
cache.get('key');

// Computed path — should NOT match.
const PATHS = { users: '/users' };
const router = Router();
router.get(PATHS.users as string, (ctx: KoaContext) => { ctx.body = []; });
