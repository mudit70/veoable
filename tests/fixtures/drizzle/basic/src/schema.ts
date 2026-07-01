// Drizzle pgTable stub so the fixture compiles standalone.
function pgTable<T>(_name: string, _shape: T) { return _shape; }
function text(_name?: string) { return {} as { primaryKey: () => unknown }; }
function serial(_name?: string) { return {} as { primaryKey: () => unknown }; }
function timestamp(_name?: string) { return {}; }

export const usersTable = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email'),
  name: text('name'),
  createdAt: timestamp('created_at'),
});

export const postsTable = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title'),
  authorId: serial('author_id'),
});
