"""File with no kafka import — must produce zero emits."""


class FakeProducer:
    def send(self, topic, value=None):
        pass


def local() -> None:
    p = FakeProducer()
    p.send('not-a-kafka-topic', value=b'data')
