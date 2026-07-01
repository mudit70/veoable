"""Fixture for framework-httpx — covers httpx + requests."""

import httpx
import requests


# ── Top-level httpx convenience ────────────────────────────────────
def top_level_httpx_get():
    return httpx.get("https://api.example.com/users")


async def top_level_httpx_post_async():
    async with httpx.AsyncClient() as client:
        return await client.post("https://api.example.com/users")


# ── httpx.Client method chain ──────────────────────────────────────
def httpx_client_methods():
    with httpx.Client() as client:
        client.get("https://api.example.com/users")
        client.post("https://api.example.com/users")
        client.put("https://api.example.com/users/1")
        client.delete("https://api.example.com/users/1")
        client.patch("https://api.example.com/users/1")
        client.head("https://api.example.com/users")


# ── requests top-level ─────────────────────────────────────────────
def requests_top_level():
    requests.get("https://api.example.com/items")
    requests.post("https://api.example.com/items")
    requests.delete("https://api.example.com/items/1")


# ── requests Session method chain ──────────────────────────────────
def requests_session_methods():
    session = requests.Session()
    session.get("https://api.example.com/things")
    session.post("https://api.example.com/things")


# ── Dynamic URL (f-string) — should emit but with urlLiteral=None ──
def dynamic_url_fstring():
    user_id = 42
    requests.get(f"https://api.example.com/users/{user_id}")


# ── Adjacent string concat ─────────────────────────────────────────
def adjacent_string_concat():
    httpx.get("https://api.example.com" "/concat/path")


# ── Negative: unrelated `.get(key)` on a dict ──────────────────────
def unrelated_dict_get():
    data = {"foo": 1, "bar": 2}
    # `data.get(...)` is NOT an HTTP call. RECEIVER_RE rejects.
    return data.get("foo")


# ── Negative: `os.environ.get(...)` ────────────────────────────────
def env_get():
    import os
    return os.environ.get("PATH")


# ── url= keyword-only form (common in real codebases) ──────────────
def kwarg_url_only():
    # No positional URL — visitor picks the `url=` kwarg as a fallback.
    requests.get(url="https://api.example.com/kwarg")


# ── self.session.get inside a class ────────────────────────────────
class ApiWrapper:
    def __init__(self):
        self.session = requests.Session()

    def fetch(self):
        return self.session.get("https://api.example.com/wrapped")
