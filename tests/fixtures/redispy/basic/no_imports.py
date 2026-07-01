"""Negative: no redis import. Visitor must not fire."""


class FakeRedis:
    def get(self, k):
        return None


def looks_like_redis_but_isnt():
    rdb = FakeRedis()
    return rdb.get('user:1')
