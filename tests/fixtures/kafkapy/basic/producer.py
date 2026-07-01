"""kafka-python and confluent-kafka producer surfaces."""

from kafka import KafkaProducer
from confluent_kafka import Producer
from aiokafka import AIOKafkaProducer


def kp_send(p: KafkaProducer) -> None:
    p.send('user-events', value=b'data')


def kp_send_kwarg(p: KafkaProducer) -> None:
    p.send(topic='order-events', value=b'data')


def ck_produce(p: Producer) -> None:
    p.produce('payments', value=b'data')


def dynamic_topic(p: KafkaProducer, topic: str) -> None:
    # Dynamic topic — must NOT emit (we can't classify by literal).
    p.send(topic, value=b'data')


async def aio_send_and_wait(p: AIOKafkaProducer) -> None:
    await p.send_and_wait('async-events', value=b'data')


async def aio_send_batch(p: AIOKafkaProducer, batch) -> None:
    await p.send_batch('async-batches', batch)
