// File without memcache crate use — must produce zero emits.

pub struct FakeStore;

impl FakeStore {
    pub fn get(&self, _key: &str) {}
    pub fn set(&self, _key: &str, _v: &str, _ttl: u32) {}
}

pub fn local(s: &FakeStore) {
    s.get("not-memcache");
    s.set("not-memcache", "val", 0);
}
