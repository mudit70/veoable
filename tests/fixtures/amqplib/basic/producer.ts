import amqp from 'amqplib';

export async function publishOrder() {
  const conn = await amqp.connect('amqp://localhost');
  const channel = await conn.createChannel();
  channel.publish('orders', 'order.created', Buffer.from('data'));
}

export async function sendToQueueDirect() {
  const conn = await amqp.connect('amqp://localhost');
  const channel = await conn.createChannel();
  channel.sendToQueue('emails', Buffer.from('data'));
}

export async function dynamicTopic(routingKey: string) {
  const conn = await amqp.connect('amqp://localhost');
  const channel = await conn.createChannel();
  channel.publish('orders', routingKey, Buffer.from('data'));
}
