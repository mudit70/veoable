import amqp from 'amqplib';

export async function startConsumer() {
  const conn = await amqp.connect('amqp://localhost');
  const channel = await conn.createChannel();
  await channel.consume('order.created', () => {});
  await channel.consume('emails', () => {});
}
