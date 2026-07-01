import * as fs from 'node:fs';
import * as path from 'node:path';
import { idFor, type DatabaseTable } from '@veoable/schema';

/**
 * Scan TS source files for `@Schema()`-decorated classes (NestJS Mongoose
 * pattern) and `mongoose.model('Name', schema)` calls (plain Mongoose).
 * Emits a `DatabaseTable` per detected schema and returns a class-name →
 * collection-name map for the visitor's call-site → table resolution
 * (#178).
 *
 * Regex-based — handles the common patterns; ts-morph would be more
 * precise but adds a runtime dep on lang-ts. Patterns out of scope:
 *   - Schemas defined via `new mongoose.Schema({...})` and registered
 *     elsewhere (the registration site is what binds the name).
 *   - Inline `template:`-style schema definitions that nobody writes.
 *   - Cross-file constant references in `collection: COLLECTION_NAME`.
 */
export interface ScanResult {
  tables: DatabaseTable[];
  /** Class name → collection name. Used by the visitor to resolve the
   *  CRUD-call receiver (`this.userModel`) to a `DatabaseTable`. */
  classToCollection: Map<string, string>;
}

export function scanMongooseSchemas(
  rootDir: string,
  files: readonly string[],
  systemId: string,
): ScanResult {
  const tables: DatabaseTable[] = [];
  const classToCollection = new Map<string, string>();
  const seenIds = new Set<string>();

  for (const file of files) {
    if (!file.endsWith('.ts')) continue;
    // Defense-in-depth: confirm the resolved path stays under rootDir
    // even though `files` should already be project-discovered.
    const abs = path.resolve(rootDir, file);
    const safeRoot = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
    if (!abs.startsWith(safeRoot) && abs !== rootDir) continue;
    let source: string;
    try {
      source = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    // Cheap pre-filter — two layers:
    //   1. Must mention @Schema or mongoose.model(. Cuts most files.
    //   2. Must import from one of the Mongoose packages. Stops cross-library
    //      `@Schema` decorators (e.g., other libs that happen to export
    //      a `@Schema()` macro) from polluting the schema map. Narrow but
    //      real false-positive surface in projects that use both Mongoose
    //      and another `@Schema`-emitting library in the same codebase.
    if (!source.includes('@Schema') && !source.includes('mongoose.model(')) continue;
    if (!source.includes('@nestjs/mongoose') && !source.includes("'mongoose'") && !source.includes('"mongoose"')) {
      continue;
    }

    for (const decl of findSchemaDeclarations(source)) {
      const collection = decl.collection ?? defaultCollection(decl.className);
      const id = idFor.databaseTable({ systemId, schema: null, name: collection });
      if (seenIds.has(id)) {
        // Multiple schemas in different files claiming the same collection
        // name — keep the first, ignore subsequent. (Unusual but possible
        // with shared schemas; the first wins because emission is idempotent
        // anyway and we only need one node.)
        classToCollection.set(decl.className, collection);
        continue;
      }
      seenIds.add(id);
      tables.push({
        nodeType: 'DatabaseTable',
        id,
        systemId,
        name: collection,
        schema: null,
        kind: 'collection',
        declaredIn: file,
      });
      classToCollection.set(decl.className, collection);
    }
  }

  return { tables, classToCollection };
}

interface SchemaDecl {
  className: string;
  /** Explicit `collection: '...'` from `@Schema({ collection: '...' })`,
   *  or null when the schema uses the default. */
  collection: string | null;
}

/**
 * Find every Mongoose schema declaration in a file.
 * Recognized:
 *   - `@Schema({ collection: 'foo', ... }) class FooSchema { ... }`  (NestJS)
 *   - `@Schema({ ... }) class Foo { ... }`                            (NestJS, default collection)
 *   - `@Schema() class Foo { ... }`                                   (NestJS, default collection, no opts)
 *   - `mongoose.model('Foo', fooSchema)`                              (plain mongoose)
 *
 * Tolerates JSDoc / line comments between `@Schema()` and the class
 * declaration. The model name comes from the class declaration for
 * `@Schema()` and from the first string literal argument for
 * `mongoose.model()`.
 *
 * @internal — exported for testing; consumers should call
 *             `scanMongooseSchemas` instead.
 */
export function findSchemaDeclarations(source: string): SchemaDecl[] {
  const out: SchemaDecl[] = [];

  // @Schema(...) [comments / whitespace] class Foo
  // The interleave (`(?:…)*`) absorbs JSDoc and `//` line comments that
  // sit between the decorator and the class declaration.
  const COMMENT_OR_WS = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
  const SCHEMA_RE = new RegExp(
    String.raw`@Schema\s*\(\s*(\{[\s\S]*?\})?\s*\)` +
    COMMENT_OR_WS +
    String.raw`(?:export\s+)?(?:abstract\s+)?class\s+([A-Z][\w]*)`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = SCHEMA_RE.exec(source)) !== null) {
    const optsBody = m[1];
    const className = m[2];
    let collection: string | null = null;
    if (optsBody) {
      const colMatch = /\bcollection\s*:\s*['"`]([^'"`]+)['"`]/.exec(optsBody);
      if (colMatch) collection = colMatch[1];
    }
    out.push({ className, collection });
  }

  // mongoose.model('Foo', ...) — model names can be lower- or upper-case
  // (mongoose itself doesn't constrain). Require at least one identifier
  // character so we don't match `mongoose.model('', schema)` accidentally.
  const MODEL_RE = /\bmongoose\s*\.\s*model\s*\(\s*['"`]([A-Za-z_$][\w$]*)['"`]/g;
  while ((m = MODEL_RE.exec(source)) !== null) {
    out.push({ className: m[1], collection: null });
  }

  return out;
}

/**
 * Mongoose-style default collection name from a class name. Mirrors
 * mongoose's `pluralize` for the cases that show up in real codebases:
 *   - Already-pluralized words ending in `s` stay the same: `Tips → tips`
 *   - Consonant + y → ies: `City → cities`
 *   - Sibilant endings get `es`: `Box → boxes`, `Bus → buses`, `Match → matches`
 *   - Otherwise + s: `User → users`
 *
 * For schemas with a non-default collection name, callers should set
 * `@Schema({ collection: '...' })` explicitly — the regex picks that up
 * and uses it instead of this default.
 */
export function defaultCollection(className: string): string {
  const lower = className.toLowerCase();
  if (lower.endsWith('s')) return lower;
  if (/[bcdfghjklmnpqrstvwxz]y$/.test(lower)) return lower.slice(0, -1) + 'ies';
  if (/(x|z|ch|sh)$/.test(lower)) return lower + 'es';
  return lower + 's';
}
