import { Kafka, Consumer } from 'kafkajs';

const kafka = new Kafka({ clientId: 'app', brokers: ['localhost:9092'] });
const consumer: Consumer = kafka.consumer({ groupId: 'g1' });

export async function subscribeSingle() {
  await consumer.subscribe({ topic: 'user-events' });
}

export async function subscribeMany() {
  await consumer.subscribe({ topics: ['payments', 'notifications'] });
}

export async function subscribeDynamic(topic: string) {
  // Dynamic — variable, not literal. Must NOT emit.
  await consumer.subscribe({ topic });
}
