"""pika consumer surface."""

import pika


def on_message(ch, method, properties, body):
    pass


def start_consumer():
    conn = pika.BlockingConnection()
    channel = conn.channel()
    channel.basic_consume(queue='order.created', on_message_callback=on_message)
    channel.basic_consume(queue='audit.write', on_message_callback=on_message)
