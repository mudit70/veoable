// The wrapper class lives in `wrapper-class.ts`; this file just
// imports + uses it. Pins that cross-file resolution finds the
// wrapper through the import + ts-morph's type system.
import { PostAPIClient } from './wrapper-class.js';

const client = new PostAPIClient('/api/cross-file');

export async function callFromOtherFile(name: string) {
  return client.post(name, { x: 1 });
}

export async function callWithLiteralName() {
  return client.post('CrossFileLiteral', {});
}
