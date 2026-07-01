"""File without sqlmodel — must produce zero emits."""


class Fake:
    def add(self, x):
        pass


def local():
    Fake().add('nope')
