"""pymemcache surface."""

from pymemcache.client.base import Client

client = Client(('localhost', 11211))


def get_user(uid: str):
    return client.get('user:1')


def set_user():
    return client.set('user:1', 'alice')


def add_entry():
    return client.add('entry:new', 'data')


def replace_entry():
    return client.replace('entry:existing', 'new-data')


def incr_counter():
    return client.incr('counter:requests', 1)


def decr_counter():
    return client.decr('counter:errors', 1)


def delete_session():
    return client.delete('session:abc')


def touch_key():
    return client.touch('session:keepalive', 60)


def get_many():
    return client.get_many(['key1', 'key2'])


def dynamic_key(k: str):
    # Dynamic — per-call-site placeholder.
    return client.get(k)
