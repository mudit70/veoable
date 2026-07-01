// This file deliberately mimics the tRPC proxy-call shape but
// imports NO trpc-flavored module. It exercises false-positive
// candidates the visitor should NOT emit callers for:
//
//   - knex/mongoose: db.users.query()
//   - formik / reactive store: store.values.user.mutate()
//   - some other library's typed hooks: x.y.z.useQuery()
//
// All three call shapes match `<root>.<seg+>.<hook>()`, but with no
// `import … from '*trpc*'` in this file the per-file gate suppresses
// emission.

import { db } from './fake-db';
import { store } from './fake-store';
import { somethingElse } from './fake-lib';

export function NotATrpcComponent() {
  const a = db.users.query();
  const b = store.values.user.mutate();
  const c = somethingElse.foo.bar.useQuery();
  return { a, b, c };
}
