"""pika producer surface."""

import pika


def publish_order():
    conn = pika.BlockingConnection()
    channel = conn.channel()
    channel.basic_publish(exchange='orders', routing_key='order.created', body=b'data')


def publish_audit():
    conn = pika.BlockingConnection()
    channel = conn.channel()
    channel.basic_publish(exchange='audit', routing_key='audit.write', body=b'data')


def dynamic_topic(routing_key: str):
    conn = pika.BlockingConnection()
    channel = conn.channel()
    channel.basic_publish(exchange='orders', routing_key=routing_key, body=b'data')
