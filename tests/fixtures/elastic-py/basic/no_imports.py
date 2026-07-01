"""File without elasticsearch import — must produce zero emits."""


class FakeStore:
    def search(self, *, index: str, body: dict):
        pass


def local():
    s = FakeStore()
    s.search(index="not-elastic", body={})
