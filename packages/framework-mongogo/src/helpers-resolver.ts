import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Cross-file collection-helper resolver.
 *
 * Real-world Go projects often wrap collection access in helper
 * functions:
 *
 *   // db/mongo.go
 *   func Vehicles(client *mongo.Client) *mongo.Collection {
 *       return client.Database("fleet").Collection("vehicles")
 *   }
 *
 *   // handlers/vehicles.go
 *   func List(c *gin.Context) {
 *       col := db.Vehicles(client)   // ← visitor must resolve this
 *       col.Find(...)
 *   }
 *
 * The per-file binding scanner in `visitor.ts` can't see across files.
 * This resolver runs once at project load — it walks every `.go`
 * file in the project and regex-extracts helper signatures that
 * return a mongo collection inlined as `…Database("a").Collection("b")`.
 *
 * The returned map's keys are bare function names (e.g. `Vehicles`).
 * Lookups against `<pkg>.<Func>` selectors strip the package prefix.
 * If two packages export a helper with the same name pointing at
 * different collections, last-write-wins — known limitation,
 * acceptable for the projects we see in practice.
 */

export interface CollectionHelperMap {
  /** Bare function name → collection name. */
  byFunctionName: ReadonlyMap<string, string>;
}

/**
 * Walk `rootDir` for `.go` files and build the helper map. Returns
 * an empty map when no Go files are found.
 */
export function buildCollectionHelperMap(rootDir: string): CollectionHelperMap {
  const goFiles = findGoFiles(rootDir);
  if (goFiles.length === 0) return { byFunctionName: new Map() };

  const out = new Map<string, string>();
  for (const file of goFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    extractHelpers(content, out);
  }
  return { byFunctionName: out };
}

/**
 * Match `func <name>(...) *mongo.Collection { ... return ... Collection("X") ... }`
 * blocks. We use a two-stage regex: first locate the function header,
 * then look for the nearest `Collection("...")` inside the body before
 * the next blank line or `func` declaration.
 *
 * Patterns accepted:
 *
 *   func Vehicles(client *mongo.Client) *mongo.Collection {
 *       return client.Database("fleet").Collection("vehicles")
 *   }
 *
 *   func (s *Store) Vehicles() *mongo.Collection {
 *       return s.client.Database("fleet").Collection("vehicles")
 *   }
 *
 *   func Pings(c *mongo.Client) *mongo.Collection { return c.Database("fleet").Collection("pings") }
 *
 *   // tuple return — common in error-returning constructors
 *   func Users(c *mongo.Client) (*mongo.Collection, error) {
 *       return c.Database("app").Collection("users"), nil
 *   }
 *
 *   // named return
 *   func Comments(c *mongo.Client) (col *mongo.Collection) {
 *       col = c.Database("app").Collection("comments")
 *       return
 *   }
 *
 *   // generic helper (Go 1.18+)
 *   func Articles[T any](c *mongo.Client) *mongo.Collection {
 *       return c.Database("app").Collection("articles")
 *   }
 */
// Anatomy of the regex (broken into pieces for readability when
// reading the source):
//   func                               # keyword
//   (?:\s*\([^)]*\))?                  # optional method receiver
//   \s+([A-Z][A-Za-z0-9_]*)            # exported function name
//   \s*(?:\[[^\]]*\])?                 # optional Go-1.18 generics
//   \s*\([^)]*\)                       # parameter list
//   \s*<RETURN>\s*\{                   # return signature + body open
//
// <RETURN> accepts three shapes:
//   - bare:  `*mongo.Collection`
//   - parenthesised: `(... *mongo.Collection ...)` — covers tuple
//     returns, named returns, and any combination of the two
const HELPER_HEADER_RE =
  /func(?:\s*\([^)]*\))?\s+([A-Z][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*\([^)]*\)\s*(?:\([^)]*\*\s*mongo\.Collection[^)]*\)|\*\s*mongo\.Collection)\s*\{/g;
const COLLECTION_CALL_RE = /\bCollection\(\s*"([^"]+)"\s*\)/;

function extractHelpers(content: string, out: Map<string, string>): void {
  HELPER_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HELPER_HEADER_RE.exec(content)) !== null) {
    const funcName = m[1]!;
    const bodyStart = m.index + m[0].length;
    // Find the matching close brace by counting depth — Go function
    // bodies routinely have nested braces (composite literals, ifs,
    // type-asserts). A naive next-`}` would misbehave on:
    //   func Foo() *mongo.Collection {
    //       opts := struct{ X int }{ X: 1 }
    //       return ...
    //   }
    const bodyEnd = findMatchingClose(content, bodyStart);
    const body = bodyEnd > bodyStart ? content.slice(bodyStart, bodyEnd) : content.slice(bodyStart);
    const colMatch = COLLECTION_CALL_RE.exec(body);
    if (colMatch) {
      const collection = colMatch[1]!;
      const prior = out.get(funcName);
      if (prior !== undefined && prior !== collection) {
        // Two packages exported the same helper name pointing at
        // different collections. Last-write-wins (documented above),
        // but log so users investigating a "wrong collection name"
        // can spot the overwrite.
        // eslint-disable-next-line no-console
        console.warn(
          `[framework-mongogo] helper "${funcName}" maps to multiple ` +
          `collections ("${prior}" → "${collection}"); last-write-wins. ` +
          `Disambiguate by renaming one of the helpers.`,
        );
      }
      out.set(funcName, collection);
    }
  }
}

function findMatchingClose(content: string, startIdx: number): number {
  let depth = 1;
  for (let i = startIdx; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return content.length;
}

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
]);

function findGoFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out;
}
