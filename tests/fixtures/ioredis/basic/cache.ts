import Redis from 'ioredis';

const redis = new Redis();
const client = new Redis();

export async function getUser(id: string) {
  return redis.get(`user:${id}`);
}

export async function setUser(id: string, name: string) {
  return redis.set(`user:${id}`, name);
}

export async function incrCounter() {
  return redis.incr('counter:requests');
}

export async function decrCounter() {
  return redis.decr('counter:errors');
}

export async function listKeys() {
  return redis.keys('user:*');
}

export async function hashSet() {
  return client.hset('profile', 'field', 'value');
}

export async function hashGetAll() {
  return client.hgetall('profile');
}

export async function setAdd() {
  return redis.sadd('active_users', 'alice');
}

export async function setRemove() {
  return redis.srem('active_users', 'alice');
}

export async function zsetAdd() {
  return redis.zadd('leaderboard', 100, 'alice');
}

export async function zsetRange() {
  return redis.zrange('leaderboard', 0, 9);
}

export async function listPush() {
  return redis.lpush('queue:jobs', 'job-data');
}

export async function listPop() {
  return redis.lpop('queue:jobs');
}

export async function expireKey() {
  return redis.expire('session:abc', 3600);
}

export async function deleteKey() {
  return redis.del('temp:abc');
}

export async function publishEvent() {
  return redis.publish('channel:events', 'event-payload');
}

export async function dynamicKey(key: string) {
  // Dynamic key — per-call-site placeholder.
  return redis.get(key);
}
