"""File without pika import — must produce zero emits."""


class FakeChannel:
    def basic_publish(self, exchange, routing_key, body):
        pass


def local():
    c = FakeChannel()
    c.basic_publish(exchange='nope', routing_key='nope', body=b'x')
