import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LanguagePlugin, FrameworkVisitor, ProjectHandle, ProjectOptions, NodeBatch } from '@adorable/plugin-api';
import type { GoFrameworkVisitor } from './framework-visitor.js';

export const GO_PLUGIN_ID = 'go' as const;
export const GO_FILE_EXTENSIONS = ['.go'] as const;

import type Parser from 'web-tree-sitter';

let TreeSitter: typeof Parser | null = null;
let GoLanguage: Parser.Language | null = null;

async function ensureParser(): Promise<void> {
  if (TreeSitter && GoLanguage) return;
  const mod = await import('web-tree-sitter');
  TreeSitter = mod.default;
  await TreeSitter.init();

  // Load the Go WASM grammar from tree-sitter-wasms package.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  const wasmPath = path.join(wasmsDir, 'out', 'tree-sitter-go.wasm');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`tree-sitter-go.wasm not found at ${wasmPath}`);
  }

  GoLanguage = await TreeSitter.Language.load(wasmPath);
}

interface GoProjectInternal {
  rootDir: string;
  repository: string;
}

const projectHandleBrand: unique symbol = Symbol('GoProjectHandle');

function makeHandle(internal: GoProjectInternal): ProjectHandle {
  return { [projectHandleBrand]: true, ...internal } as unknown as ProjectHandle;
}

function unwrapHandle(handle: ProjectHandle): GoProjectInternal {
  return handle as unknown as GoProjectInternal;
}

export class GoLanguagePlugin implements LanguagePlugin {
  readonly id = GO_PLUGIN_ID;
  readonly fileExtensions = GO_FILE_EXTENSIONS;

  private visitors: GoFrameworkVisitor[] = [];

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
    // Defense-in-depth: prevent path traversal.
    const safeRoot = internal.rootDir.endsWith(path.sep) ? internal.rootDir : internal.rootDir + path.sep;
    if (!absPath.startsWith(safeRoot) && absPath !== internal.rootDir) {
      throw new Error(`Path traversal denied: ${filePath}`);
    }
    const source = fs.readFileSync(absPath, 'utf-8');

    // TreeSitter is guaranteed non-null — ensureParser() awaited in loadProject().
    const parser = new TreeSitter!();
    parser.setLanguage(GoLanguage!);
    const tree = parser.parse(source);

    const { extractGoFile } = await import('./extract-source-file.js');
    return extractGoFile(
      tree,
      filePath,
      internal.repository,
      internal.rootDir,
      this.visitors
    );
  }

  registerVisitor(visitor: FrameworkVisitor): void {
    if (visitor.language !== 'go') {
      throw new Error(`GoLanguagePlugin: visitor language must be 'go', got '${visitor.language}'`);
    }
    this.visitors.push(visitor as GoFrameworkVisitor);
  }
}
