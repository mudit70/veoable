import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { idFor } from '@veoable/schema';
import { defaultCollection, findSchemaDeclarations, scanMongooseSchemas } from '../schema-scanner.js';

describe('defaultCollection', () => {
  it('lowercases and pluralizes simple class names', () => {
    expect(defaultCollection('User')).toBe('users');
    expect(defaultCollection('Song')).toBe('songs');
    expect(defaultCollection('Notification')).toBe('notifications');
  });

  it('handles consonant + y → ies', () => {
    expect(defaultCollection('City')).toBe('cities');
    expect(defaultCollection('Category')).toBe('categories');
  });

  it('keeps vowel + y unchanged before pluralization', () => {
    expect(defaultCollection('Day')).toBe('days');
    expect(defaultCollection('Key')).toBe('keys');
  });

  it('appends "es" to sibilant endings', () => {
    expect(defaultCollection('Box')).toBe('boxes');
    expect(defaultCollection('Buzz')).toBe('buzzes');
    expect(defaultCollection('Match')).toBe('matches');
    expect(defaultCollection('Wish')).toBe('wishes');
  });

  it('leaves words already ending in -s unchanged (e.g., "Tips")', () => {
    expect(defaultCollection('Tips')).toBe('tips');
    expect(defaultCollection('News')).toBe('news');
  });

  it('handles compound class names without splitting them', () => {
    // FollowUser → followusers (mongoose default — no underscore).
    // Schemas that need follow_users / song_requests must use
    // explicit @Schema({ collection: '...' }) overrides; that's
    // covered by findSchemaDeclarations, not this default helper.
    expect(defaultCollection('FollowUser')).toBe('followusers');
    expect(defaultCollection('SongRequest')).toBe('songrequests');
  });
});

describe('findSchemaDeclarations', () => {
  it('finds @Schema()-decorated classes and returns the class name', () => {
    const source = `
      import { Schema } from '@nestjs/mongoose';
      @Schema()
      export class User {}
    `;
    expect(findSchemaDeclarations(source)).toEqual([
      { className: 'User', collection: null },
    ]);
  });

  it('extracts an explicit `collection: "..."` override from the @Schema body', () => {
    const source = `
      @Schema({ collection: 'follow_users', timestamps: true })
      export class FollowUser {}
    `;
    expect(findSchemaDeclarations(source)).toEqual([
      { className: 'FollowUser', collection: 'follow_users' },
    ]);
  });

  it('handles abstract / no-export class declarations', () => {
    const source = `@Schema() abstract class BaseDoc {}`;
    expect(findSchemaDeclarations(source)).toEqual([
      { className: 'BaseDoc', collection: null },
    ]);
  });

  it('finds multiple schemas in one file', () => {
    const source = `
      @Schema() export class A {}
      @Schema({ collection: 'override' }) export class B {}
    `;
    const decls = findSchemaDeclarations(source);
    expect(decls).toEqual([
      { className: 'A', collection: null },
      { className: 'B', collection: 'override' },
    ]);
  });

  it('finds plain mongoose.model("Name", schema) calls', () => {
    const source = `
      import mongoose from 'mongoose';
      const userSchema = new mongoose.Schema({});
      mongoose.model('User', userSchema);
    `;
    expect(findSchemaDeclarations(source)).toEqual([
      { className: 'User', collection: null },
    ]);
  });

  it('matches lowercase mongoose.model() names too', () => {
    // mongoose itself doesn't constrain the case; older codebases
    // sometimes register lower-case model names.
    const source = `mongoose.model('user', userSchema);`;
    expect(findSchemaDeclarations(source)).toEqual([
      { className: 'user', collection: null },
    ]);
  });

  it('tolerates JSDoc / line comments between @Schema() and the class', () => {
    const source = `
      @Schema({ collection: 'users' })
      /** User document — see docs/auth.md */
      // additional notes
      export class User {}
    `;
    expect(findSchemaDeclarations(source)).toEqual([
      { className: 'User', collection: 'users' },
    ]);
  });

  it('returns the class with default collection when @Schema({ collection }) references a non-literal constant', () => {
    // Cross-file constant references for `collection: SOME_CONSTANT` are
    // intentionally out of scope — the regex requires a string literal.
    // We expect the schema to fall through to defaultCollection() on the
    // class name rather than extracting the identifier text.
    const source = `
      @Schema({ collection: COLLECTION_USERS })
      export class User {}
    `;
    expect(findSchemaDeclarations(source)).toEqual([
      { className: 'User', collection: null },
    ]);
  });

  it('does not match @Schema usages without the followup class declaration', () => {
    // E.g., MongooseSchema.Types.ObjectId references — no class follows.
    const source = `
      const x = Schema.Types.ObjectId;
    `;
    expect(findSchemaDeclarations(source)).toEqual([]);
  });
});

describe('scanMongooseSchemas', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoose-scan-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function write(rel: string, body: string): string {
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
    return rel;
  }

  it('emits a DatabaseTable per @Schema() class with the default collection name', () => {
    const f1 = write('src/user.schema.ts', `import { Schema } from '@nestjs/mongoose';
      @Schema() export class User {}`);
    const f2 = write('src/song.schema.ts', `import { Schema } from '@nestjs/mongoose';
      @Schema() export class Song {}`);
    const result = scanMongooseSchemas(tmpRoot, [f1, f2], 'sys-1');

    expect(result.tables).toHaveLength(2);
    expect(result.tables.map((t) => t.name).sort()).toEqual(['songs', 'users']);
    expect(result.tables.every((t) => t.kind === 'collection')).toBe(true);
    expect(result.tables.every((t) => t.systemId === 'sys-1')).toBe(true);

    expect(result.classToCollection.get('User')).toBe('users');
    expect(result.classToCollection.get('Song')).toBe('songs');
  });

  it('respects @Schema({ collection: "..." }) overrides', () => {
    const f = write('src/follow.schema.ts', `
      import { Schema } from '@nestjs/mongoose';
      @Schema({ collection: 'follow_users', timestamps: true })
      export class FollowUser {}
    `);
    const result = scanMongooseSchemas(tmpRoot, [f], 'sys-1');

    expect(result.tables.map((t) => t.name)).toEqual(['follow_users']);
    expect(result.classToCollection.get('FollowUser')).toBe('follow_users');
  });

  it('attaches declaredIn to the source file path', () => {
    const f = write('src/user.schema.ts', `import { Schema } from '@nestjs/mongoose';
      @Schema() export class User {}`);
    const result = scanMongooseSchemas(tmpRoot, [f], 'sys-1');
    expect(result.tables[0].declaredIn).toBe(f);
  });

  it('skips files that do not reference @Schema or mongoose.model (cheap pre-filter)', () => {
    const f = write('src/util.ts', `export const x = 1;`);
    const result = scanMongooseSchemas(tmpRoot, [f], 'sys-1');
    expect(result.tables).toHaveLength(0);
    expect(result.classToCollection.size).toBe(0);
  });

  it('skips non-.ts files entirely', () => {
    const f = write('src/user.schema.js', `import { Schema } from '@nestjs/mongoose';
      @Schema() export class User {}`);
    const result = scanMongooseSchemas(tmpRoot, [f], 'sys-1');
    expect(result.tables).toHaveLength(0);
  });

  it('produces deterministic ids matching idFor.databaseTable output', () => {
    const f = write('src/user.schema.ts', `import { Schema } from '@nestjs/mongoose';
      @Schema() export class User {}`);
    const result = scanMongooseSchemas(tmpRoot, [f], 'sys-1');
    const expectedId = idFor.databaseTable({ systemId: 'sys-1', schema: null, name: 'users' });
    expect(result.tables[0].id).toBe(expectedId);
  });

  it('deduplicates schemas claiming the same collection across multiple files', () => {
    const f1 = write('src/a/user.schema.ts', `import { Schema } from '@nestjs/mongoose';
      @Schema() export class User {}`);
    const f2 = write('src/b/user.schema.ts', `import { Schema } from '@nestjs/mongoose';
      @Schema() export class User {}`);
    const result = scanMongooseSchemas(tmpRoot, [f1, f2], 'sys-1');
    // Only one table emitted; the class→collection map is populated for both.
    expect(result.tables).toHaveLength(1);
    expect(result.classToCollection.get('User')).toBe('users');
  });

  it('handles plain mongoose.model() registration end-to-end', () => {
    const f = write('src/models.ts', `
      import mongoose from 'mongoose';
      const userSchema = new mongoose.Schema({ name: String });
      mongoose.model('User', userSchema);
    `);
    const result = scanMongooseSchemas(tmpRoot, [f], 'sys-1');
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe('users');
    expect(result.tables[0].kind).toBe('collection');
    expect(result.classToCollection.get('User')).toBe('users');
  });

  it('handles a file mixing @Schema() and mongoose.model() patterns', () => {
    const f = write('src/mixed.ts', `
      import mongoose from 'mongoose';
      import { Schema } from '@nestjs/mongoose';
      @Schema() export class Post {}
      mongoose.model('Comment', new mongoose.Schema({}));
    `);
    const result = scanMongooseSchemas(tmpRoot, [f], 'sys-1');
    expect(result.tables.map((t) => t.name).sort()).toEqual(['comments', 'posts']);
  });

  it('falls back to defaultCollection when @Schema({ collection: SOME_CONST }) references a non-literal', () => {
    const f = write('src/user.schema.ts', `
      import { Schema } from '@nestjs/mongoose';
      @Schema({ collection: COLLECTION_USERS })
      export class User {}
    `);
    const result = scanMongooseSchemas(tmpRoot, [f], 'sys-1');
    // Falls through to defaultCollection('User') = 'users' since the
    // regex couldn't statically extract the override.
    expect(result.tables.map((t) => t.name)).toEqual(['users']);
    expect(result.classToCollection.get('User')).toBe('users');
  });

  it('skips files that mention @Schema but do not import from a Mongoose package (cross-library guard)', () => {
    // A file that has `@Schema()` from some other library and never
    // imports from mongoose / @nestjs/mongoose. Without the
    // import-presence guard we'd false-positive and emit a DatabaseTable
    // for an unrelated class.
    const f = write('src/some-other-lib.ts', `
      import { Schema } from 'some-other-graphql-lib';
      @Schema()
      export class GraphQLType {}
    `);
    const result = scanMongooseSchemas(tmpRoot, [f], 'sys-1');
    expect(result.tables).toHaveLength(0);
    expect(result.classToCollection.size).toBe(0);
  });

  it('still detects a Mongoose schema in a file that imports from "mongoose" (no @nestjs/mongoose)', () => {
    // Plain Mongoose users that don't go through NestJS still need
    // detection to work — the import-presence guard accepts both packages.
    const f = write('src/plain.ts', `
      import { Schema, model } from 'mongoose';
      mongoose.model('User', new Schema({}));
    `);
    const result = scanMongooseSchemas(tmpRoot, [f], 'sys-1');
    expect(result.tables.map((t) => t.name)).toEqual(['users']);
  });
});
