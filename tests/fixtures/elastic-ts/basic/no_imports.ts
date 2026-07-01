// File without @elastic/elasticsearch import — must produce zero
// emits even though `client.search(...)` shape matches.

const fakeClient = {
  search(_opts: { index: string }) {
    return Promise.resolve();
  },
};

export function local() {
  return fakeClient.search({ index: 'not-elastic' });
}
