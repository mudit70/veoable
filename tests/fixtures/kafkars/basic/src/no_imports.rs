// File without rdkafka use — must produce zero emits even though it
// has a `subscribe` method and a `::to` style call.

pub struct FakeBus;

impl FakeBus {
    pub fn subscribe(&self, _topics: &[&str]) {}
}

pub fn local(b: &FakeBus) {
    b.subscribe(&["not-a-kafka-topic"]);
}
