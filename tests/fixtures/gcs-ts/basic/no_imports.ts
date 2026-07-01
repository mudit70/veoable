// No @google-cloud/storage import — these chains should produce zero emits.

class FakeFile {
  download() { return Promise.resolve(); }
  save(_buf: Buffer) { return Promise.resolve(); }
}
class FakeBucket {
  file(_k: string) { return new FakeFile(); }
}
class FakeStorage {
  bucket(_b: string) { return new FakeBucket(); }
}

const fake = new FakeStorage();

export async function localFetch() {
  return fake.bucket('nope').file('nope').download();
}
export async function localSave() {
  return fake.bucket('nope').file('nope').save(Buffer.from(''));
}
