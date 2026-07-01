import { BlobServiceClient } from '@azure/storage-blob';

const svc = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true');

export async function fetchBlob() {
  // GET → azure://static-assets/logo.png
  return svc.getContainerClient('static-assets').getBlobClient('logo.png').download();
}

export async function uploadBlob() {
  // PUT → azure://user-uploads/inbox/new.txt
  return svc
    .getContainerClient('user-uploads')
    .getBlockBlobClient('inbox/new.txt')
    .upload('hi', 2);
}

export async function deleteBlob() {
  // DELETE → azure://archive/2026/snapshot.tar
  return svc.getContainerClient('archive').getBlobClient('2026/snapshot.tar').delete();
}

export async function existsBlob() {
  // GET (exists) → azure://static-assets/logo.png
  return svc.getContainerClient('static-assets').getBlobClient('logo.png').exists();
}

export async function setBlobMetadata() {
  // PUT (setMetadata) → azure://configs/app.json
  return svc.getContainerClient('configs').getBlobClient('app.json').setMetadata({ k: 'v' });
}

export async function uploadAppendBlob() {
  // PUT → azure://logs/system.log
  return svc.getContainerClient('logs').getAppendBlobClient('system.log').appendBlock('line\n', 5);
}

export async function uploadPageBlob() {
  // PUT (create) → azure://vhd/disk.vhd
  return svc.getContainerClient('vhd').getPageBlobClient('disk.vhd').create(1024);
}

export async function listInContainer() {
  // GET → azure://static-assets/ (container scope)
  return svc.getContainerClient('static-assets').listBlobsFlat();
}

export async function deleteContainer() {
  // DELETE → azure://temp-container/ (container scope)
  return svc.getContainerClient('temp-container').delete();
}

export async function createContainer() {
  // PUT (create) → azure://new-container/ (container scope)
  return svc.getContainerClient('new-container').create();
}

export async function dynamicContainer(name: string) {
  // GET (dynamic container) → null URL
  return svc.getContainerClient(name).getBlobClient('logo.png').download();
}

export async function dynamicBlob(key: string) {
  // GET (literal container, dynamic blob) → azure://static-assets/ (dynamic)
  return svc.getContainerClient('static-assets').getBlobClient(key).download();
}
