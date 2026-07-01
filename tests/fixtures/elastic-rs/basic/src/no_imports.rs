// File without elasticsearch crate use — must produce zero emits.

pub struct FakeStore;

impl FakeStore {
    pub async fn index(&self, _opts: ()) {}
    pub async fn search(&self, _opts: ()) {}
}

pub async fn local(s: &FakeStore) {
    s.index(()).await;
    s.search(()).await;
}
