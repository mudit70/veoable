import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LanguagePlugin, FrameworkVisitor, ProjectHandle, ProjectOptions, NodeBatch } from '@adorable/plugin-api';
import type { JavaFrameworkVisitor } from './framework-visitor.js';

export const JAVA_PLUGIN_ID = 'java' as const;
export const JAVA_FILE_EXTENSIONS = ['.java'] as const;

import type Parser from 'web-tree-sitter';

let TreeSitter: typeof Parser | null = null;
let JavaLanguage: Parser.Language | null = null;

async function ensureParser(): Promise<void> {
  if (TreeSitter && JavaLanguage) return;
  const mod = await import('web-tree-sitter');
  TreeSitter = mod.default;
  await TreeSitter.init();

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  const wasmPath = path.join(wasmsDir, 'out', 'tree-sitter-java.wasm');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`tree-sitter-java.wasm not found at ${wasmPath}`);
  }

  JavaLanguage = await TreeSitter.Language.load(wasmPath);
}

interface JavaProjectInternal {
  rootDir: string;
  repository: string;
}

const projectHandleBrand: unique symbol = Symbol('JavaProjectHandle');

function makeHandle(internal: JavaProjectInternal): ProjectHandle {
  return { [projectHandleBrand]: true, ...internal } as unknown as ProjectHandle;
}

function unwrapHandle(handle: ProjectHandle): JavaProjectInternal {
  return handle as unknown as JavaProjectInternal;
}

export class JavaLanguagePlugin implements LanguagePlugin {
  readonly id = JAVA_PLUGIN_ID;
  readonly fileExtensions = JAVA_FILE_EXTENSIONS;

  private visitors: JavaFrameworkVisitor[] = [];

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
    parser.setLanguage(JavaLanguage!);
    const tree = parser.parse(source);

    const { extractJavaFile } = await import('./extract-source-file.js');
    return extractJavaFile(
      tree,
      filePath,
      internal.repository,
      internal.rootDir,
      this.visitors
    );
  }

  registerVisitor(visitor: FrameworkVisitor): void {
    if (visitor.language !== 'java') {
      throw new Error(`JavaLanguagePlugin: visitor language must be 'java', got '${visitor.language}'`);
    }
    this.visitors.push(visitor as JavaFrameworkVisitor);
  }
}
