// File without kafkajs import — must produce zero emits even though
// it happens to have a .send({ topic }) shape.

interface FakeProducer {
  send(opts: { topic: string }): Promise<void>;
}

const fake = { async send(_opts: { topic: string }) {} } as FakeProducer;

export async function localSend() {
  await fake.send({ topic: 'not-a-kafka-topic' });
}
