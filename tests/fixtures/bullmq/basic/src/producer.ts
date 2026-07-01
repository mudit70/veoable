import { Queue } from 'bullmq';

const uploadQueue = new Queue('uploads', { connection: { host: 'localhost' } });
const emailQueue = new Queue('emails', { connection: { host: 'localhost' } });

export async function enqueueUpload(file: Buffer) {
  await uploadQueue.add('process-upload', { file });
}

export async function enqueueWelcomeEmail(to: string) {
  await emailQueue.add('welcome', { to });
}

// Negative: queue.add called on a binding that's not a Queue.
declare const fakeQueue: { add: (n: string, p: unknown) => void };
export function notABullmq() {
  fakeQueue.add('unrelated', {});
}
