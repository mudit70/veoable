"""websockets server + client surface."""

import asyncio
import websockets
from websockets import serve, connect


async def handler(ws):
    async for msg in ws:
        await ws.send(msg)


async def serve_qualified():
    async with websockets.serve(handler, "localhost", 8765):
        await asyncio.Future()


async def serve_unqualified():
    async with serve(handler, "localhost", 8766):
        await asyncio.Future()


async def connect_qualified():
    async with websockets.connect("ws://api.example.com/feed") as ws:
        await ws.send("hello")


async def connect_unqualified():
    async with connect("ws://api.example.com/orders") as ws:
        await ws.send("hello")


async def connect_dynamic(url: str):
    # Dynamic URL — must NOT emit a caller (no literal).
    async with websockets.connect(url) as ws:
        await ws.send("hello")
