// MikroORM EntitySchema builder pattern (#383).
// No decorators — entities are declared via `new EntitySchema(...)`
// and exported as variables. We test name resolution + property
// extraction on this shape.

// Stub the EntitySchema export so the fixture type-checks standalone.
class EntitySchema<T = unknown> {
  constructor(_cfg: unknown) { void this; void _cfg; }
}

interface User {
  id: number;
  email: string;
  name: string;
}

export const UserSchema = new EntitySchema<User>({
  name: 'User',
  tableName: 'users',
  properties: {
    id: { type: 'number', primary: true },
    email: { type: 'string' },
    name: { type: 'string', nullable: true },
  },
});

// Variant with no `tableName` — falls back to `name`.
interface Post {
  id: number;
  title: string;
}
export const PostSchema = new EntitySchema<Post>({
  name: 'posts',
  properties: {
    id: { type: 'number', primary: true },
    title: { type: 'string' },
  },
});
