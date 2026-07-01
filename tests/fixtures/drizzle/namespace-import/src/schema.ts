function pgTable<T>(_name: string, _shape: T) { return _shape; }
function text(_name?: string) { return {} as { primaryKey: () => unknown }; }
function serial(_name?: string) { return {} as { primaryKey: () => unknown }; }

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email'),
});

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title'),
});

export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  action: text('action'),
});
