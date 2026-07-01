// File without amqplib import — must produce zero emits.

const fake = {
  publish(_e: string, _r: string, _b: Buffer) {},
};

export async function nope() {
  fake.publish('nope', 'nope', Buffer.from('x'));
}
