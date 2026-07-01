"""File without peewee import — must produce zero emits."""


class Foo:
    @staticmethod
    def select():
        pass


def local():
    Foo.select()
