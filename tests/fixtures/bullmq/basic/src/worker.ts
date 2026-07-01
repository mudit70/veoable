import { Worker } from 'bullmq';

new Worker('uploads', async (job) => {
  console.log('processing upload', job.id);
}, { connection: { host: 'localhost' } });

new Worker('emails', async (job) => {
  console.log('sending email', job.data);
}, { connection: { host: 'localhost' } });
