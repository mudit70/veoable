// File without @aws-sdk/client-s3 import — must produce zero emits
// even though it happens to have a class named GetObjectCommand.

class GetObjectCommand {
  constructor(public opts: { Bucket: string; Key: string }) {}
}

const fake = {
  send(_cmd: GetObjectCommand) {
    return Promise.resolve();
  },
};

export async function local() {
  return fake.send(new GetObjectCommand({ Bucket: 'fake', Key: 'fake' }));
}
