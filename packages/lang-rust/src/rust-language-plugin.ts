import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LanguagePlugin, FrameworkVisitor, ProjectHandle, ProjectOptions, NodeBatch } from '@adorable/plugin-api';
import type { RustFrameworkVisitor } from './framework-visitor.js';

export const RUST_PLUGIN_ID = 'rust' as const;
export const RUST_FILE_EXTENSIONS = ['.rs'] as const;

import type Parser from 'web-tree-sitter';

let TreeSitter: typeof Parser | null = null;
let RustLanguage: Parser.Language | null = null;

async function ensureParser(): Promise<void> {
  if (TreeSitter && RustLanguage) return;
  const mod = await import('web-tree-sitter');
  TreeSitter = mod.default;
  await TreeSitter.init();

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  const wasmPath = path.join(wasmsDir, 'out', 'tree-sitter-rust.wasm');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`tree-sitter-rust.wasm not found at ${wasmPath}`);
  }

  RustLanguage = await TreeSitter.Language.load(wasmPath);
}

interface RustProjectInternal {
  rootDir: string;
  repository: string;
}

const projectHandleBrand: unique symbol = Symbol('RustProjectHandle');

function makeHandle(internal: RustProjectInternal): ProjectHandle {
  return { [projectHandleBrand]: true, ...internal } as unknown as ProjectHandle;
}

function unwrapHandle(handle: ProjectHandle): RustProjectInternal {
  return handle as unknown as RustProjectInternal;
}

export class RustLanguagePlugin implements LanguagePlugin {
  readonly id = RUST_PLUGIN_ID;
  readonly fileExtensions = RUST_FILE_EXTENSIONS;

  private visitors: RustFrameworkVisitor[] = [];

  async loadProject(opts: ProjectOptions): Promise<ProjectHandle> {
    await ensureParser();
    return makeHandle({
      rootDir: path.resolve(opts.rootDir),
      repository: opts.repository ?? path.basename(opts.rootDir),
    });
  }

  async extractFile(project: ProjectHandle, filePath: string): Promise<NodeBatch> {
    const internal = unwrapHandle(project);
    const absPath = path.resolve(internal.rootDir, filePath);
    const safeRoot = internal.rootDir.endsWith(path.sep) ? internal.rootDir : internal.rootDir + path.sep;
    if (!absPath.startsWith(safeRoot) && absPath !== internal.rootDir) {
      throw new Error(`Path traversal denied: ${filePath}`);
    }
    const source = fs.readFileSync(absPath, 'utf-8');

    const parser = new TreeSitter!();
    parser.setLanguage(RustLanguage!);
    const tree = parser.parse(source);

    const { extractRustFile } = await import('./extract-source-file.js');
    return extractRustFile(tree, filePath, internal.repository, internal.rootDir, this.visitors);
  }

  registerVisitor(visitor: FrameworkVisitor): void {
    if (visitor.language !== 'rust') {
      throw new Error(`RustLanguagePlugin: visitor language must be 'rust', got '${visitor.language}'`);
    }
    this.visitors.push(visitor as RustFrameworkVisitor);
  }
}
