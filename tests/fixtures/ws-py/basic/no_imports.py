"""File without websockets import — must produce zero emits."""


class FakeBus:
    def serve(self, handler, host, port):
        pass


def setup():
    bus = FakeBus()
    bus.serve(lambda x: x, "localhost", 9000)
