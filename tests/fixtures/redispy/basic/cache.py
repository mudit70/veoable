"""Fixture for framework-redispy."""

import redis

# Canonical client construction.
rdb = redis.Redis(host='localhost', port=6379)
cache = redis.from_url('redis://localhost:6379/0')


def get_user(uid):
    return rdb.get(f'user:{uid}')


def set_user(uid, data):
    rdb.set(f'user:{uid}', data)


def list_user_keys():
    return rdb.keys('user:*')


def increment_counter():
    rdb.incr('counter:requests')


def decrement_counter():
    rdb.decr('counter:requests')


def hash_set_user(uid, data):
    rdb.hset(f'user:{uid}:profile', mapping=data)


def hash_get_user(uid):
    return rdb.hgetall(f'user:{uid}:profile')


def add_to_set(member):
    rdb.sadd('active_users', member)


def remove_from_set(member):
    rdb.srem('active_users', member)


def add_to_sorted_set(score, member):
    rdb.zadd('leaderboard', {member: score})


def query_leaderboard():
    return rdb.zrange('leaderboard', 0, 10)


def lpush_queue(item):
    rdb.lpush('queue:jobs', item)


def rpush_queue(item):
    rdb.rpush('queue:jobs', item)


def lpop_queue():
    return rdb.lpop('queue:jobs')


def expire_key(uid):
    rdb.expire(f'session:{uid}', 3600)


def delete_user(uid):
    rdb.delete(f'user:{uid}')


# ── publish/subscribe ──
def publish_event(channel, message):
    rdb.publish(channel, message)


# ── alternate client `cache` ──
def cache_get(key):
    return cache.get(key)


def cache_set(key, value):
    cache.set(key, value)


# ── dynamic key — non-string arg ──
def dynamic_key_get(key_var):
    return rdb.get(key_var)


# ── Negative: dict.get/set on something that isn't a Redis client ──
def unrelated():
    d = {'foo': 1}
    return d.get('foo')


# ── self.<client> binding inside a class ──
class CacheService:
    def __init__(self):
        self.r = redis.Redis()

    def fetch(self, k):
        return self.r.get(k)
