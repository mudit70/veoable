"""Negative: no aiohttp import — visitor must not fire."""

class FakeSession:
    async def get(self, url):
        return None

async def looks_like_aiohttp_but_isnt():
    session = FakeSession()
    return await session.get('https://api.example.com/nope')
