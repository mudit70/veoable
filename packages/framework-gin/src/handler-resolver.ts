import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Cross-file handler resolver for Gin route registrations.
 *
 * Most real Gin apps register handlers as method calls on a binding
 * whose type was constructed in another file:
 *
 *   // main.go
 *   v := handlers.NewVehicles(db)
 *   r.GET("/api/vehicles", v.List)        // ← need handlerFunctionId
 *
 *   // handlers/vehicles.go
 *   func (v *Vehicles) List(c *gin.Context) { … }
 *
 * The visitor can see the call site (`v.List`) but not the
 * definition (`func (v *Vehicles) List`). A per-file scan won't
 * cross the package boundary. This resolver walks every `.go` file
 * in the project once at load time, recording every function and
 * method declaration with its name, line, and source-file path. The
 * visitor then looks up handler call sites by name.
 *
 * Bare identifiers (`r.GET("/x", handleX)`) and method receivers
 * (`r.GET("/x", v.List)`) are both handled — the receiver's local
 * binding name is dropped and the lookup is by method name only,
 * which is conservatively safe given:
 *
 *   - if a method name is globally unique → emit its id
 *   - if it's not unique → leave null (avoid false positives)
 *
 * Caveat: a globally-unique method whose canonical use isn't an HTTP
 * handler (e.g. a unique `Handle` on a `*Logger` struct) WILL resolve.
 * That's an intentional v1 tradeoff — we accept the rare false-positive
 * to avoid the much more common false-negative.
 *
 * Known regex gaps deferred to follow-ups:
 *   - Go 1.18+ generic functions/methods: `func Foo[T any](...)` and
 *     `func (r *Type[T]) Method(...)` are missed because the regex
 *     expects the parameter `(` immediately after the name. Real Gin
 *     handlers are rarely generic; add `\[[^\]]*\]?` between name and
 *     `(` when this becomes a recurring pattern.
 *
 * Function literals (`r.GET("/x", func(c *gin.Context) { … })`) get
 * no entry because lang-go doesn't emit FunctionDefinition nodes for
 * inline anonymous functions.
 *
 * Identity of the entries:
 *   `name`         the value lang-go computes for the FunctionDefinition
 *                  (`Vehicles.List` for methods, `handleX` for free fns)
 *   `filePath`     relative-from-rootDir source-file path (used to
 *                  compute the same sourceFileId lang-go uses)
 *   `sourceLine`   1-indexed line of the declaration
 */

export interface HandlerEntry {
  /** Function definition name as lang-go would compute it. */
  readonly name: string;
  /** Source-file path relative to rootDir. */
  readonly filePath: string;
  /** 1-indexed source line of the declaration. */
  readonly sourceLine: number;
}

export interface HandlerMap {
  /**
   * Lookup key → matching entry. Returns null when the lookup name
   * is ambiguous (more than one match) so the visitor falls back to
   * leaving `handlerFunctionId` null rather than picking arbitrarily.
   *
   * Keys are:
   *   - bare method name (`List`) — covers `r.GET("/x", v.List)`
   *   - bare function name (`handleX`) — covers `r.GET("/x", handleX)`
   */
  readonly byName: ReadonlyMap<string, HandlerEntry | null>;
}

/**
 * Walk `rootDir` for `.go` files and build the handler map. Returns
 * an empty map when no Go files are found.
 */
export function buildGinHandlerMap(rootDir: string): HandlerMap {
  const goFiles = findGoFiles(rootDir);
  if (goFiles.length === 0) return { byName: new Map() };

  // First pass: collect every match, allowing duplicates per name.
  const collected = new Map<string, HandlerEntry[]>();
  for (const abs of goFiles) {
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const relPath = path.relative(rootDir, abs).split(path.sep).join('/');
    extractDeclarations(content, relPath, collected);
  }

  // Second pass: resolve ambiguity. Unique → entry; ambiguous → null.
  const byName = new Map<string, HandlerEntry | null>();
  for (const [name, entries] of collected) {
    byName.set(name, entries.length === 1 ? entries[0] : null);
  }
  return { byName };
}

// Matches:
//   func Name(...)
//   func   Name  (...)
// Captures: name. Line number is computed by counting newlines up to match.
const FUNC_DECL_RE = /^[ \t]*func\s+([A-Za-z_][\w]*)\s*\(/gm;

// Matches:
//   func (r *Type) Name(...)
//   func (Type) Name(...)
//   func (r Type) Name(...)
//   func (r *pkg.Type) Name(...)   ← star with package-scoped type, rare but valid
// Captures: receiver type (without `*` / package prefix), method name.
const METHOD_DECL_RE =
  /^[ \t]*func\s*\(\s*(?:[A-Za-z_][\w]*\s+)?\*?\s*(?:[A-Za-z_][\w]*\.)?([A-Za-z_][\w]*)\s*\)\s+([A-Za-z_][\w]*)\s*\(/gm;

function extractDeclarations(
  content: string,
  filePath: string,
  out: Map<string, HandlerEntry[]>,
): void {
  const push = (lookupName: string, entry: HandlerEntry): void => {
    const list = out.get(lookupName);
    if (list) list.push(entry);
    else out.set(lookupName, [entry]);
  };

  // Method declarations: keep the typed form for lang-go's
  // FunctionDefinition.name (`Vehicles.List`), but key by the bare
  // method name so the visitor can look up `v.List` without
  // resolving `v`'s type.
  METHOD_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = METHOD_DECL_RE.exec(content)) !== null) {
    const receiverType = m[1]!;
    const methodName = m[2]!;
    const sourceLine = lineNumberAtIndex(content, m.index);
    const entry: HandlerEntry = {
      name: `${receiverType}.${methodName}`,
      filePath,
      sourceLine,
    };
    push(methodName, entry);
  }

  // Free function declarations: the lookup name and the function
  // name are the same.
  FUNC_DECL_RE.lastIndex = 0;
  while ((m = FUNC_DECL_RE.exec(content)) !== null) {
    const fnName = m[1]!;
    const sourceLine = lineNumberAtIndex(content, m.index);
    const entry: HandlerEntry = {
      name: fnName,
      filePath,
      sourceLine,
    };
    push(fnName, entry);
  }
}

function lineNumberAtIndex(text: string, index: number): number {
  // 1-indexed line. Count newlines in [0, index).
  let count = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  // Go convention: `testdata/` contains files the compiler ignores
  // (used for test inputs). Walking it would produce phantom handler
  // matches that point at unreachable code.
  'testdata',
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
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.go') &&
        !entry.name.endsWith('_test.go')
      ) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out;
}
