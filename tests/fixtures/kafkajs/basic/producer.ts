import { Kafka, Producer } from 'kafkajs';

const kafka = new Kafka({ clientId: 'app', brokers: ['localhost:9092'] });
const producer: Producer = kafka.producer();

export async function sendOne() {
  await producer.send({
    topic: 'user-events',
    messages: [{ value: 'payload' }],
  });
}

export async function sendOrders() {
  await producer.send({
    topic: 'orders',
    messages: [{ value: 'payload' }],
  });
}

export async function sendBatchMulti() {
  await producer.sendBatch({
    topicMessages: [
      { topic: 'payments', messages: [{ value: 'a' }] },
      { topic: 'audit-log', messages: [{ value: 'b' }] },
    ],
  });
}

export async function dynamicTopic(topic: string) {
  // Dynamic topic — must NOT emit (no literal).
  await producer.send({ topic, messages: [{ value: 'x' }] });
}
