import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';

const client = new S3Client({ region: 'us-east-1' });

export async function fetchObject() {
  return client.send(new GetObjectCommand({ Bucket: 'static-assets', Key: 'logo.png' }));
}

export async function headObject() {
  return client.send(new HeadObjectCommand({ Bucket: 'static-assets', Key: 'logo.png' }));
}

export async function listInbox() {
  return client.send(new ListObjectsV2Command({ Bucket: 'user-uploads', Prefix: 'inbox/' }));
}

export async function uploadObject() {
  return client.send(new PutObjectCommand({ Bucket: 'user-uploads', Key: 'inbox/new.txt', Body: 'data' }));
}

export async function copyObject() {
  return client.send(
    new CopyObjectCommand({ Bucket: 'archive', Key: '2026/snapshot.tar', CopySource: 'user-uploads/inbox/new.txt' }),
  );
}

export async function deleteObject() {
  return client.send(new DeleteObjectCommand({ Bucket: 'user-uploads', Key: 'inbox/old.txt' }));
}

export async function startMultipart() {
  return client.send(new CreateMultipartUploadCommand({ Bucket: 'user-uploads', Key: 'large/movie.mp4' }));
}

export async function headBucket() {
  return client.send(new HeadBucketCommand({ Bucket: 'static-assets' }));
}

export async function listBuckets() {
  return client.send(new ListBucketsCommand({}));
}

export async function deleteBucket() {
  return client.send(new DeleteBucketCommand({ Bucket: 'ephemeral-test-bucket' }));
}

export async function dynamicBucket(bucket: string, key: string) {
  // Dynamic bucket+key → urlLiteral=null, egressConfidence=dynamic.
  return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}

export async function literalBucketOnly() {
  // Literal bucket, dynamic key → urlLiteral=s3://known-bucket/, exact.
  return client.send(new GetObjectCommand({ Bucket: 'known-bucket', Key: someVar() }));
}

function someVar(): string {
  return 'runtime';
}
