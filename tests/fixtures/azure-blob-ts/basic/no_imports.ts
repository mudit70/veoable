// No @azure/storage-blob import — these chains should produce zero emits.

class FakeBlob {
  download() { return Promise.resolve(); }
  upload(_buf: string, _len: number) { return Promise.resolve(); }
  delete() { return Promise.resolve(); }
}
class FakeContainer {
  getBlobClient(_k: string) { return new FakeBlob(); }
  getBlockBlobClient(_k: string) { return new FakeBlob(); }
}
class FakeSvc {
  getContainerClient(_c: string) { return new FakeContainer(); }
}

const fake = new FakeSvc();

export async function localFetch() {
  return fake.getContainerClient('nope').getBlobClient('nope').download();
}
export async function localUpload() {
  return fake.getContainerClient('nope').getBlockBlobClient('nope').upload('x', 1);
}
