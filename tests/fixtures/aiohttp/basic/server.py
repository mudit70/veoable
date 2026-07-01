"""Fixture for framework-aiohttp — server + client patterns."""

import aiohttp
from aiohttp import web

routes = web.RouteTableDef()


# ── Decorator on a RouteTableDef ───────────────────────────────────
@routes.get('/users')
async def get_users(request):
    return web.json_response([])


@routes.post('/users')
async def create_user(request):
    return web.json_response({})


@routes.put('/users/{user_id}')
async def update_user(request):
    return web.json_response({})


@routes.delete('/users/{user_id}')
async def delete_user(request):
    return web.json_response({})


# ── Class-based view (web.View) ────────────────────────────────────
class ItemView(web.View):
    async def get(self):
        return web.json_response([])

    async def post(self):
        return web.json_response({})

    # Non-verb methods are NOT emitted as endpoints.
    async def helper(self):
        return None


# ── Negative: a regular class NOT inheriting from web.View ─────────
class PlainHelper:
    async def get(self):
        return None


# ── app.router.add_<verb>(URL, handler) call form ──────────────────
async def build_app():
    app = web.Application()
    app.router.add_get('/health', health_handler)
    app.router.add_post('/login', login_handler)
    app.router.add_routes(routes)
    return app


async def health_handler(request):
    return web.Response(text='ok')


async def login_handler(request):
    return web.json_response({'token': 'x'})


# ── web.<verb>(URL, handler) constructor form inside add_routes ────
async def build_app_constructor_form():
    app = web.Application()
    app.add_routes([
        web.get('/ping', ping_handler),
        web.post('/echo', echo_handler),
    ])
    return app


async def ping_handler(request):
    return web.Response(text='pong')


async def echo_handler(request):
    return web.Response(text='echo')


# ── CLIENT-SIDE: session.get/post/put/delete/patch/head ────────────
async def fetch_users():
    async with aiohttp.ClientSession() as session:
        async with session.get('https://api.example.com/users') as resp:
            return await resp.json()


async def create_user_remote():
    async with aiohttp.ClientSession() as session:
        async with session.post('https://api.example.com/users') as resp:
            return await resp.json()


async def update_user_remote():
    async with aiohttp.ClientSession() as session:
        async with session.put('https://api.example.com/users/1') as resp:
            return await resp.json()


async def delete_user_remote():
    async with aiohttp.ClientSession() as session:
        async with session.delete('https://api.example.com/users/1') as resp:
            return await resp.json()


# ── Dynamic URL — f-string → urlLiteral null, dynamic ─────────────
async def fetch_user_dynamic(user_id: int):
    async with aiohttp.ClientSession() as session:
        async with session.get(f'https://api.example.com/users/{user_id}') as resp:
            return await resp.json()


# ── Negative: dict.get(key) on something that is NOT a session ─────
def unrelated_get():
    data = {'foo': 1}
    return data.get('foo')
