import Koa from 'koa';
import Router from '@koa/router';

const app = new Koa();
const router = new Router({ prefix: '/api' });

// Named handler
async function listUsers(ctx: Router.RouterContext) {
  ctx.body = [{ id: 1, name: 'Alice' }];
}

router.get('/users', listUsers);
router.get('/users/:id', async (ctx) => { ctx.body = { id: ctx.params.id }; });
router.post('/users', async (ctx) => { ctx.status = 201; ctx.body = {}; });
router.put('/users/:id', async (ctx) => { ctx.body = { updated: true }; });
router.delete('/users/:id', async (ctx) => { ctx.status = 204; });

app.use(router.routes());
app.use(router.allowedMethods());
