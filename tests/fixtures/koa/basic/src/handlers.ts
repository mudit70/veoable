import { type KoaContext } from './koa-stubs.js';

export function getHealth(ctx: KoaContext) {
  ctx.body = { status: 'ok' };
}

export const createItem = (ctx: KoaContext) => {
  ctx.status = 201;
  ctx.body = {};
};
