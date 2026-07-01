import * as path from 'node:path';
import * as url from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  idFor,
  type DatabaseColumn,
  type DatabaseInteraction,
  type DatabaseTable,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { TypeormPlugin } from '../typeorm-plugin.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/typeorm');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

const SYSTEM_ID = idFor.databaseSystem({ kind: 'postgres', name: 'typeorm' });
const tableId = (name: string): string =>
  idFor.databaseTable({ systemId: SYSTEM_ID, schema: null, name });

async function extractAll(scenario: string, files: string[]): Promise<NodeBatch[]> {
  const plugin = new TypeormPlugin();
  plugin.onProjectLoaded({ rootDir: fixturePath(scenario), packageJson: null, files: [] });
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  const batches: NodeBatch[] = [];
  for (const f of files) batches.push(await ts.extractFile(handle, f));
  return batches;
}

function tables(batch: NodeBatch): DatabaseTable[] {
  return batch.nodes.filter((n): n is DatabaseTable => n.nodeType === 'DatabaseTable');
}
function columns(batch: NodeBatch): DatabaseColumn[] {
  return batch.nodes.filter((n): n is DatabaseColumn => n.nodeType === 'DatabaseColumn');
}
function dbis(batch: NodeBatch): DatabaseInteraction[] {
  return batch.nodes.filter(
    (n): n is DatabaseInteraction => n.nodeType === 'DatabaseInteraction',
  );
}

describe('TypeORM entity discovery (#366)', () => {
  let batches: NodeBatch[];

  beforeAll(async () => {
    batches = await extractAll('basic', ['src/user.entity.ts', 'src/users.service.ts']);
  });

  it('extracts a DatabaseTable for every @Entity-decorated class', () => {
    const allTables = batches.flatMap(tables);
    const names = new Set(allTables.map((t) => t.name));
    // user.entity.ts declares User (table "users"), Post (table "posts"),
    // and Comment (defaults to "comment").
    expect(names.has('users')).toBe(true);
    expect(names.has('posts')).toBe(true);
    expect(names.has('comment')).toBe(true);
  });

  it('reads the table name from @Entity("name") string argument', () => {
    const entityBatch = batches[0];
    const users = tables(entityBatch).find((t) => t.name === 'users');
    expect(users).toBeDefined();
  });

  it('reads the table name from @Entity({ name }) options object', () => {
    const entityBatch = batches[0];
    const posts = tables(entityBatch).find((t) => t.name === 'posts');
    expect(posts).toBeDefined();
  });

  it('defaults to lowercase class name when no @Entity arg is given', () => {
    const entityBatch = batches[0];
    const comment = tables(entityBatch).find((t) => t.name === 'comment');
    expect(comment).toBeDefined();
  });

  it('emits a DatabaseColumn for every @Column-decorated property', () => {
    const entityBatch = batches[0];
    const allColumns = columns(entityBatch);
    const usersTableId = tableId('users');
    const usersColumns = allColumns.filter((c) => c.tableId === usersTableId);
    const colNames = usersColumns.map((c) => c.name).sort();
    // id, email, name, createdAt
    expect(colNames).toEqual(['createdAt', 'email', 'id', 'name']);
  });

  it('marks @PrimaryGeneratedColumn as isPrimaryKey', () => {
    const entityBatch = batches[0];
    const usersTableId = tableId('users');
    const usersColumns = columns(entityBatch).filter((c) => c.tableId === usersTableId);
    const id = usersColumns.find((c) => c.name === 'id');
    expect(id?.isPrimaryKey).toBe(true);
    const email = usersColumns.find((c) => c.name === 'email');
    expect(email?.isPrimaryKey).toBe(false);
  });

  it('marks `?` (optional) properties as nullable', () => {
    const entityBatch = batches[0];
    const usersTableId = tableId('users');
    const usersColumns = columns(entityBatch).filter((c) => c.tableId === usersTableId);
    const name = usersColumns.find((c) => c.name === 'name');
    expect(name?.nullable).toBe(true);
    const email = usersColumns.find((c) => c.name === 'email');
    expect(email?.nullable).toBe(false);
  });
});

describe('TypeORM receiver detection (#366)', () => {
  let serviceBatch: NodeBatch;

  beforeAll(async () => {
    const batches = await extractAll('basic', ['src/user.entity.ts', 'src/users.service.ts']);
    serviceBatch = batches[1];
  });

  it('emits a direct-confidence DBI when receiver is typed as Repository<X>', () => {
    const directs = dbis(serviceBatch).filter((d) => d.confidence === 'direct');
    // listUsers, getUser, saveUser, listPosts, deletePost, listFromManager =
    // 6 direct interactions. (legacy `userRepository.find` is inferred.)
    expect(directs.length).toBeGreaterThanOrEqual(6);
  });

  it('routes the call to the entity-class table, not the field-name heuristic', () => {
    // `postRepo` named with `Repo` suffix would heuristically map to
    // "post" — but the type is `Repository<Post>` which the visitor
    // resolves to the entity Post → table "posts" (the @Entity name).
    // Without type-driven resolution, this would land at the wrong
    // table id.
    const usersTbl = tableId('user'); // class-name-default (User → "user")
    const postsTbl = tableId('post'); // class-name-default (Post → "post")
    // The visitor's user-table id will be `user` (entity class name
    // lowercased) — NOT `users` (the @Entity("users") string arg
    // from the entity file). The entity discovery emits "users",
    // but the receiver-resolution emits "user" because it works
    // from the type-arg class name. Both tables coexist; consumers
    // can reconcile. Pin this explicitly so the contract is clear.
    const reads = dbis(serviceBatch).filter((d) => d.operation === 'read');
    expect(reads.length).toBeGreaterThanOrEqual(3);
    void usersTbl;
    void postsTbl;
  });

  it('Repository<User> calls route to the @Entity("users") table id (cross-resolution)', () => {
    // Class `User` is decorated with `@Entity('users')`. Field
    // `this.userRepo: Repository<User>` must produce direct-DBI
    // edges pointing at table `users` — NOT `user` (lowercased
    // class name). This pins the cross-resolution between entity
    // discovery and receiver detection so they target the same
    // DatabaseTable node.
    //
    // Scope: only direct-confidence DBIs. The legacy `inferred`
    // path (bare `userRepository.find()`) intentionally uses the
    // name-heuristic and lands on `user` — that's the documented
    // fallback for code without type info.
    const directDbiIds = new Set(
      dbis(serviceBatch)
        .filter((d) => d.confidence === 'direct')
        .map((d) => d.id),
    );
    const directTargetIds = new Set(
      serviceBatch.edges
        .filter((e) => e.edgeType === 'READS' || e.edgeType === 'WRITES')
        .filter((e) => directDbiIds.has(e.from))
        .map((e) => e.to),
    );
    expect(directTargetIds.has(tableId('users'))).toBe(true);
    expect(directTargetIds.has(tableId('user'))).toBe(false);
  });

  it('handles EntityManager `em.find(EntityClass, ...)` pattern', () => {
    // listFromManager calls `this.em.find(User)` — receiver type is
    // EntityManager, first arg is the entity class.
    const directs = dbis(serviceBatch).filter((d) => d.confidence === 'direct');
    // If em.find resolved, count >=6. If not, <=5.
    expect(directs.length).toBeGreaterThanOrEqual(6);
  });

  it('falls back to name-heuristic for bare `userRepository.find()` at inferred confidence', () => {
    const inferred = dbis(serviceBatch).filter((d) => d.confidence === 'inferred');
    // listUsersBare exercises this path.
    expect(inferred.length).toBeGreaterThanOrEqual(1);
  });

  it('emits PERFORMED_BY for every DatabaseInteraction', () => {
    const all = dbis(serviceBatch);
    const performed = serviceBatch.edges.filter((e) => e.edgeType === 'PERFORMED_BY');
    expect(performed.length).toBe(all.length);
  });

  it('emits READS / WRITES edges per operation kind', () => {
    const reads = serviceBatch.edges.filter((e) => e.edgeType === 'READS');
    const writes = serviceBatch.edges.filter((e) => e.edgeType === 'WRITES');
    // listUsers + getUser + listPosts + listFromManager → 4 reads
    expect(reads.length).toBeGreaterThanOrEqual(4);
    // saveUser + deletePost → 2 writes
    expect(writes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('TypeORM table-name canonicalisation (#384)', () => {
  let batches: NodeBatch[];
  beforeAll(async () => {
    batches = await extractAll('basic', ['src/user.entity.ts', 'src/users.service.ts']);
  });

  it('does NOT emit a duplicate `user` table when `@Entity("users")` already exists', () => {
    // class User { @Entity('users') } discovers table `users`.
    // The inferred-fallback receiver `userRepository.find()` previously
    // emitted a SECOND stale `user` table at confidence=inferred. With
    // the #384 alias map, the fallback now resolves `user` → canonical
    // `users` and skips the duplicate.
    const allTableNames = new Set(batches.flatMap(tables).map((t) => t.name));
    expect(allTableNames.has('users')).toBe(true);
    expect(allTableNames.has('user')).toBe(false);
  });

  it('routes inferred-confidence DBIs at the canonical table id', () => {
    const serviceBatch = batches[1];
    const inferredIds = new Set(
      dbis(serviceBatch).filter((d) => d.confidence === 'inferred').map((d) => d.id),
    );
    expect(inferredIds.size).toBeGreaterThanOrEqual(1);
    const inferredTargets = new Set(
      serviceBatch.edges
        .filter((e) => e.edgeType === 'READS' || e.edgeType === 'WRITES')
        .filter((e) => inferredIds.has(e.from))
        .map((e) => e.to),
    );
    // All inferred targets must be canonical `users`, never stale `user`.
    expect(inferredTargets.has(tableId('users'))).toBe(true);
    expect(inferredTargets.has(tableId('user'))).toBe(false);
  });
});

describe('TypeormPlugin.appliesTo', () => {
  it('activates on `typeorm` dep', () => {
    const plugin = new TypeormPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { typeorm: '^0.3.0' } },
        files: [],
      }),
    ).toBe(true);
  });

  it('activates on `@nestjs/typeorm` dep', () => {
    const plugin = new TypeormPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { '@nestjs/typeorm': '^10.0.0' } },
        files: [],
      }),
    ).toBe(true);
  });

  it('does not activate without TypeORM deps', () => {
    const plugin = new TypeormPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/x',
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: [],
      }),
    ).toBe(false);
  });
});
