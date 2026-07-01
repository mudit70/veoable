"""File without tortoise import — must produce zero emits."""


class Foo:
    @classmethod
    async def create(cls):
        pass


async def local():
    await Foo.create()
