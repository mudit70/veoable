// Fixture for framework-redisrs.

use redis::{Client, Commands, Connection};

fn open_conn() -> redis::RedisResult<Connection> {
    let client = Client::open("redis://127.0.0.1/")?;
    client.get_connection()
}

fn get_user(conn: &mut Connection, id: u64) -> redis::RedisResult<String> {
    conn.get(&format!("user:{}", id))
}

fn set_user(conn: &mut Connection, id: u64, value: String) -> redis::RedisResult<()> {
    conn.set(&format!("user:{}", id), value)
}

fn list_user_keys(conn: &mut Connection) -> redis::RedisResult<Vec<String>> {
    conn.keys("user:*")
}

fn increment_counter(conn: &mut Connection) -> redis::RedisResult<i64> {
    conn.incr("counter:requests", 1)
}

fn decrement_counter(conn: &mut Connection) -> redis::RedisResult<i64> {
    conn.decr("counter:requests", 1)
}

fn hset_profile(conn: &mut Connection, id: u64, field: &str, val: &str) -> redis::RedisResult<()> {
    conn.hset(&format!("user:{}:profile", id), field, val)
}

fn hgetall_profile(conn: &mut Connection, id: u64) -> redis::RedisResult<Vec<(String, String)>> {
    conn.hgetall(&format!("user:{}:profile", id))
}

fn add_to_set(conn: &mut Connection, member: &str) -> redis::RedisResult<()> {
    conn.sadd("active_users", member)
}

fn remove_from_set(conn: &mut Connection, member: &str) -> redis::RedisResult<()> {
    conn.srem("active_users", member)
}

fn add_to_sorted_set(conn: &mut Connection, member: &str, score: i64) -> redis::RedisResult<()> {
    conn.zadd("leaderboard", member, score)
}

fn query_leaderboard(conn: &mut Connection) -> redis::RedisResult<Vec<String>> {
    conn.zrange("leaderboard", 0, 10)
}

fn lpush_queue(conn: &mut Connection, item: &str) -> redis::RedisResult<()> {
    conn.lpush("queue:jobs", item)
}

fn rpush_queue(conn: &mut Connection, item: &str) -> redis::RedisResult<()> {
    conn.rpush("queue:jobs", item)
}

fn lpop_queue(conn: &mut Connection) -> redis::RedisResult<Option<String>> {
    conn.lpop("queue:jobs", None)
}

fn expire_session(conn: &mut Connection, id: u64) -> redis::RedisResult<()> {
    conn.expire(&format!("session:{}", id), 3600)
}

fn delete_user(conn: &mut Connection, id: u64) -> redis::RedisResult<()> {
    conn.del(&format!("user:{}", id))
}

fn publish_event(conn: &mut Connection, channel: &str, message: &str) -> redis::RedisResult<()> {
    conn.publish(channel, message)
}

// ── Dynamic key — non-string arg ──
fn dynamic_key(conn: &mut Connection, key: &str) -> redis::RedisResult<String> {
    conn.get(key)
}

// ── self.conn binding inside an impl ──
struct CacheService {
    conn: Connection,
}

impl CacheService {
    fn fetch(&mut self, key: &str) -> redis::RedisResult<String> {
        self.conn.get(key)
    }
}

// ── Negative: a method on something that isn't a Redis conn ──
struct PlainStruct;

impl PlainStruct {
    fn get(&self, _key: &str) -> &'static str { "" }
}

fn unrelated() -> &'static str {
    let s = PlainStruct;
    s.get("not_a_redis_key")
}
