"""Fixture for framework-tornado."""

import tornado.web
import tornado.ioloop


# ── Canonical RequestHandler class with multiple HTTP-verb methods ──
class UserHandler(tornado.web.RequestHandler):
    async def get(self):
        self.write({})

    async def post(self):
        self.write({})

    async def put(self):
        self.write({})

    async def delete(self):
        self.write({})

    # Non-verb method should NOT emit.
    async def initialize(self):
        return None


# ── Bare `RequestHandler` superclass (when imported `from tornado.web
# import RequestHandler`) ──────────────────────────────────────────
from tornado.web import RequestHandler


class HealthHandler(RequestHandler):
    def get(self):
        self.write("ok")

    def head(self):
        return None


# ── A class with HTTP-verb methods but NOT inheriting from
# RequestHandler. Must NOT emit. ────────────────────────────────
class FakeHandler:
    def get(self):
        return None

    def post(self):
        return None


# ── Application routing via tuple form ─────────────────────────
def make_app():
    return tornado.web.Application([
        (r'/users', UserHandler),
        (r'/health', HealthHandler),
        # URLSpec form — same resolution semantics
        tornado.web.URLSpec(r'/spec-style', SpecStyleHandler),
    ])


class SpecStyleHandler(tornado.web.RequestHandler):
    def get(self):
        return None

    async def patch(self):
        return None


# ── Handler with no Application registration — emits with the
# synthetic /handler/<ClassName> URL and confidence='heuristic'.
class UnregisteredHandler(tornado.web.RequestHandler):
    def get(self):
        return None


# ── Multi-URL handler: same class registered under TWO routes
# (the legacy-alias pattern). Each verb method emits ONCE per URL,
# so this class contributes 2 endpoints, not 1.
class AliasedHandler(tornado.web.RequestHandler):
    async def get(self):
        return None


# ── `tornado.web.url(URL, Handler)` lowercase form. Same resolution
# semantics as URLSpec().
class UrlFormHandler(tornado.web.RequestHandler):
    def get(self):
        return None


def make_app_aliases():
    return tornado.web.Application([
        (r'/v1/aliased', AliasedHandler),
        (r'/aliased',    AliasedHandler),
        tornado.web.url(r'/url-form', UrlFormHandler),
    ])
