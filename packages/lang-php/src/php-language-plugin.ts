import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LanguagePlugin, FrameworkVisitor, ProjectHandle, ProjectOptions, NodeBatch } from '@veoable/plugin-api';
import type { PhpFrameworkVisitor } from './framework-visitor.js';

export const PHP_PLUGIN_ID = 'php' as const;
export const PHP_FILE_EXTENSIONS = ['.php'] as const;

import type Parser from 'web-tree-sitter';

let TreeSitter: typeof Parser | null = null;
let PhpLanguage: Parser.Language | null = null;

async function ensureParser(): Promise<void> {
  if (TreeSitter && PhpLanguage) return;
  const mod = await import('web-tree-sitter');
  TreeSitter = mod.default;
  await TreeSitter.init();

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  const wasmPath = path.join(wasmsDir, 'out', 'tree-sitter-php.wasm');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`tree-sitter-php.wasm not found at ${wasmPath}`);
  }

  PhpLanguage = await TreeSitter.Language.load(wasmPath);
}

interface PhpProjectInternal {
  rootDir: string;
  repository: string;
}

const projectHandleBrand: unique symbol = Symbol('PhpProjectHandle');

function makeHandle(internal: PhpProjectInternal): ProjectHandle {
  return { [projectHandleBrand]: true, ...internal } as unknown as ProjectHandle;
}

function unwrapHandle(handle: ProjectHandle): PhpProjectInternal {
  return handle as unknown as PhpProjectInternal;
}

export class PhpLanguagePlugin implements LanguagePlugin {
  readonly id = PHP_PLUGIN_ID;
  readonly fileExtensions = PHP_FILE_EXTENSIONS;

  private visitors: PhpFrameworkVisitor[] = [];

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
    parser.setLanguage(PhpLanguage!);
    const tree = parser.parse(source);

    const { extractPhpFile } = await import('./extract-source-file.js');
    return extractPhpFile(
      tree,
      filePath,
      internal.repository,
      internal.rootDir,
      this.visitors
    );
  }

  registerVisitor(visitor: FrameworkVisitor): void {
    if (visitor.language !== 'php') {
      throw new Error(`PhpLanguagePlugin: visitor language must be 'php', got '${visitor.language}'`);
    }
    this.visitors.push(visitor as PhpFrameworkVisitor);
  }
}
