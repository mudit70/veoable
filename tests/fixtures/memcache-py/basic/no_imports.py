"""File without pymemcache import — must produce zero emits."""


class FakeStore:
    def get(self, _key):
        pass


def local():
    s = FakeStore()
    s.get('not-memcache')
