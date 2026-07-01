import { Router, type KoaContext } from './koa-stubs.js';

const router = Router();

// Multi-param path.
router.get('/users/:id/posts/:postId', (ctx: KoaContext) => { ctx.body = {}; });

// Empty-string path.
router.get('', (ctx: KoaContext) => { ctx.body = 'root'; });

// Duplicate declaration — same (method, path) should collapse to a single id.
router.get('/dup', (ctx: KoaContext) => { ctx.body = 'first'; });
router.get('/dup', (ctx: KoaContext) => { ctx.body = 'second'; });
