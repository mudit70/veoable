import { Koa, Router, type KoaContext, type Middleware } from './koa-stubs.js';

const app = Koa();
const router = Router({ prefix: '/api' });

// Same-file named handler — should resolve to a FunctionDefinition.
function listUsers(ctx: KoaContext) {
  ctx.body = [];
}

// Same-file variable-bound arrow handler.
const getUserById = (ctx: KoaContext) => {
  ctx.body = { id: ctx.params.id };
};

// Routes with named handlers.
router.get('/users', listUsers);
router.get('/users/:id', getUserById);

// Route with an inline arrow handler.
router.post('/users', (ctx) => {
  ctx.status = 201;
  ctx.body = {};
});

// Route with middleware before the handler.
const requireAuth: Middleware = async (_ctx, next) => { await next(); };
router.delete('/users/:id', requireAuth, (ctx) => {
  ctx.status = 204;
});

// All Koa-router verbs at least once.
router.put('/users/:id', (ctx) => { ctx.body = {}; });
router.patch('/users/:id', (ctx) => { ctx.body = {}; });
router.head('/users/:id', (ctx) => { ctx.status = 200; });
router.options('/users/:id', (ctx) => { ctx.status = 200; });
router.all('/catch-all', (ctx) => { ctx.body = 'ok'; });

// Named route form: router.get('name', '/path', handler)
router.get('user-detail', '/users/:id/detail', (ctx) => {
  ctx.body = { id: ctx.params.id };
});

app.use(router.routes());
app.use(router.allowedMethods());
