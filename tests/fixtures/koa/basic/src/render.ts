// Round 7 — Koa server-side render fixture.
import Router from 'koa-router';

const router = new Router();

router.get('/login', (ctx) => {
  return ctx.render('auth/signin');
});

router.get('/dashboard', async (ctx) => {
  await ctx.render('account/dashboard', { user: { name: 'x' } });
});

export { router };
