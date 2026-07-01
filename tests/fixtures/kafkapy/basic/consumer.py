"""kafka-python and confluent-kafka consumer surfaces."""

from kafka import KafkaConsumer
from confluent_kafka import Consumer


def kp_ctor_topics() -> None:
    consumer = KafkaConsumer(
        'user-events',
        'order-events',
        bootstrap_servers='localhost:9092',
    )
    for msg in consumer:
        handle(msg)


def kp_subscribe_list() -> None:
    consumer = KafkaConsumer(bootstrap_servers='localhost:9092')
    consumer.subscribe(['payments'])
    for msg in consumer:
        handle(msg)


def kp_subscribe_kwarg() -> None:
    consumer = KafkaConsumer(bootstrap_servers='localhost:9092')
    consumer.subscribe(topics=['notifications'])
    for msg in consumer:
        handle(msg)


def ck_subscribe(consumer: Consumer) -> None:
    consumer.subscribe(['audit-log'])
    while True:
        msg = consumer.poll(1.0)
        if msg:
            handle(msg)


def handle(msg) -> None:
    pass
