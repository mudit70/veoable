import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #523 item 1 — cross-file struct-field constants resolver.
 *
 * Real Rust services parameterize the AWS SDK builder chain with
 * runtime config carried on a shared state struct:
 *
 *   // state.rs
 *   pub struct AppState {
 *       pub orders_table: String,
 *       pub orders_queue_url: String,
 *   }
 *   impl AppState {
 *       pub async fn new() -> Self {
 *           Self {
 *               orders_table: std::env::var("ORDERS_TABLE")
 *                   .unwrap_or_else(|_| "Orders".into()),
 *               orders_queue_url: std::env::var("ORDERS_QUEUE_URL")
 *                   .unwrap_or_else(|_| "https://sqs.us-east-1.amazonaws.com/.../orders-incoming".into()),
 *           }
 *       }
 *   }
 *
 *   // handlers/orders.rs
 *   state.dynamo.query().table_name(&state.orders_table)…
 *
 * The visitor's per-call `extractFluentArg` only matches string
 * literals, so `&state.orders_table` lands as a dynamic URL. This
 * resolver walks every `.rs` file once at project load, finds the
 * default-fallback literal for each field, and exposes
 * `lookupFieldDefault(name)` which the visitor consults when its
 * literal extractor returns null.
 *
 * What's covered:
 *   - `field: std::env::var("X").unwrap_or_else(|_| "lit".into())`
 *   - `field: std::env::var("X").unwrap_or("lit".to_string())`
 *   - `field: env::var(…).unwrap_or_else(|_| "lit".into())`
 *   - `field: "lit".into()` / `field: "lit".to_string()` / bare `field: "lit"`
 *
 * What's intentionally not covered (last-write-wins / falls through
 * to dynamic):
 *   - Compile-time `concat!(...)`
 *   - Computed values (string concat, format!)
 *   - Field initializers that delegate to another function
 *   - Field-name collision across structs (logged as a known limitation
 *     — pragmatic since real codebases don't reuse names like
 *     `orders_table` across competing structs)
 */

export interface StructFieldMap {
  /** Field name (struct-agnostic) → default literal string. */
  readonly byFieldName: ReadonlyMap<string, string>;
}

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'target',
  'vendor',
  '.git',
  'dist',
  'build',
]);

/**
 * Walk `rootDir` for `.rs` files and build the field-default map.
 * Returns an empty map when no Rust source is found.
 */
export function buildStructFieldMap(rootDir: string): StructFieldMap {
  const files = findRustFiles(rootDir);
  if (files.length === 0) return { byFieldName: new Map() };

  const out = new Map<string, string>();
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    extractFieldDefaults(content, out);
  }
  return { byFieldName: out };
}

// Single regex per fallback shape. We deliberately keep these
// surface-level — anything more sophisticated needs proper parsing,
// which lang-rust will eventually own.
// Limitation: LHS names are lowercase-only (`[a-z_][a-z0-9_]*`). Rust
// permits uppercase identifiers for `let MAX_X = "..."` style
// constants, but in practice URL/config bindings use lowercase. Not
// adjusted here to keep the regex narrow against false positives.
const FIELD_PATTERNS: Array<{ desc: string; re: RegExp }> = [
  // Struct-init forms: `field: <expr>`
  {
    desc: 'struct-field env-with-unwrap_or_else fallback',
    re: /(\b[a-z_][a-z0-9_]*)\s*:\s*(?:std::)?env::var\([^)]*\)\s*\.unwrap_or_else\s*\(\s*\|[^|]*\|\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\.(?:into|to_string|to_owned)\s*\(\s*\)\s*\)/g,
  },
  {
    desc: 'struct-field env-with-unwrap_or fallback',
    re: /(\b[a-z_][a-z0-9_]*)\s*:\s*(?:std::)?env::var\([^)]*\)\s*\.unwrap_or\s*\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\.(?:into|to_string|to_owned)\s*\(\s*\)\s*\)/g,
  },
  {
    desc: 'struct-field bare wrapped literal',
    re: /(\b[a-z_][a-z0-9_]*)\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\.(?:into|to_string|to_owned)\s*\(\s*\)/g,
  },
  {
    // Bare literal: field: "lit",
    // Anchored to ensure we're inside a struct-literal context — preceded
    // by `{` or `,`. Avoids matching strings inside `vec!["x"]` etc.
    desc: 'struct-field bare literal in struct-init context',
    re: /(?:[{,]\s*)([a-z_][a-z0-9_]*)\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*[,}\n]/g,
  },
  // `let <name> = <expr>` forms — same shapes as above. Cover the
  // case where the call site sees a local binding (worker/main.rs:
  // `let queue_url = env::var(...).unwrap_or_else(|_| "...".into())`).
  // Names collide globally across functions; last-write-wins is the
  // accepted limitation.
  {
    desc: 'let-binding env-with-unwrap_or_else fallback',
    re: /\blet\s+([a-z_][a-z0-9_]*)\s*=\s*(?:std::)?env::var\([^)]*\)\s*\.unwrap_or_else\s*\(\s*\|[^|]*\|\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\.(?:into|to_string|to_owned)\s*\(\s*\)\s*\)/g,
  },
  {
    desc: 'let-binding env-with-unwrap_or fallback',
    re: /\blet\s+([a-z_][a-z0-9_]*)\s*=\s*(?:std::)?env::var\([^)]*\)\s*\.unwrap_or\s*\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\.(?:into|to_string|to_owned)\s*\(\s*\)\s*\)/g,
  },
  {
    desc: 'let-binding bare wrapped literal',
    re: /\blet\s+([a-z_][a-z0-9_]*)\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\.(?:into|to_string|to_owned)\s*\(\s*\)/g,
  },
  {
    desc: 'let-binding bare literal',
    re: /\blet\s+([a-z_][a-z0-9_]*)\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*;/g,
  },
];

function extractFieldDefaults(content: string, out: Map<string, string>): void {
  for (const { re } of FIELD_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const fieldName = m[1]!;
      const literal = m[2]!.replace(/\\"/g, '"');
      // First match wins. Earlier patterns (env-fallback) are more
      // specific so they shouldn't be clobbered by the bare-literal
      // pattern when both could match the same site.
      if (!out.has(fieldName)) out.set(fieldName, literal);
    }
  }
}

function findRustFiles(rootDir: string): string[] {
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
      } else if (entry.isFile() && entry.name.endsWith('.rs')) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out;
}
