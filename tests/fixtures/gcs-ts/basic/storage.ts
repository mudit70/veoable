import { Storage } from '@google-cloud/storage';

const storage = new Storage();

export async function fetchObject() {
  // GET → gs://static-assets/logo.png
  return storage.bucket('static-assets').file('logo.png').download();
}

export async function uploadObject() {
  // PUT → gs://user-uploads/inbox/new.txt
  return storage.bucket('user-uploads').file('inbox/new.txt').save(Buffer.from('hi'));
}

export async function deleteObject() {
  // DELETE → gs://archive/2026/snapshot.tar
  return storage.bucket('archive').file('2026/snapshot.tar').delete();
}

export async function headObject() {
  // GET (exists) → gs://static-assets/logo.png
  return storage.bucket('static-assets').file('logo.png').exists();
}

export async function getMetadataObject() {
  // GET → gs://static-assets/logo.png
  return storage.bucket('static-assets').file('logo.png').getMetadata();
}

export async function uploadFromPath() {
  // PUT → gs://user-uploads/ (bucket scope)
  return storage.bucket('user-uploads').upload('/local/path.txt');
}

export async function listFilesInBucket() {
  // GET → gs://static-assets/ (bucket scope)
  return storage.bucket('static-assets').getFiles();
}

export async function deleteBucket() {
  // DELETE → gs://temp-bucket/ (no .file() in chain)
  return storage.bucket('temp-bucket').delete();
}

export async function copyObject() {
  // POST → gs://archive/old.tar
  return storage
    .bucket('archive')
    .file('old.tar')
    .copy(storage.bucket('archive').file('new.tar'));
}

export async function setMetadataObject() {
  // PATCH → gs://configs/app.json
  return storage.bucket('configs').file('app.json').setMetadata({ contentType: 'application/json' });
}

export async function dynamicBucket(name: string) {
  // GET (dynamic) → null
  return storage.bucket(name).file('logo.png').download();
}

export async function dynamicKey(key: string) {
  // GET (bucket exact, key dynamic) → gs://static-assets/ (dynamic confidence)
  return storage.bucket('static-assets').file(key).download();
}

export async function getSignedDownloadUrl() {
  // GET → gs://static-assets/logo.png
  return storage.bucket('static-assets').file('logo.png').getSignedUrl({ action: 'read', expires: Date.now() + 1000 });
}
