import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguagePlugin, FrameworkVisitor, ProjectHandle, ProjectOptions, NodeBatch } from '@veoable/plugin-api';
import type { PyFrameworkVisitor } from './framework-visitor.js';

export const PY_PLUGIN_ID = 'py' as const;
export const PY_FILE_EXTENSIONS = ['.py'] as const;

import type Parser from 'web-tree-sitter';

let TreeSitter: typeof Parser | null = null;
let PythonLanguage: Parser.Language | null = null;

async function ensureParser(): Promise<void> {
  if (TreeSitter && PythonLanguage) return;
  const mod = await import('web-tree-sitter');
  TreeSitter = mod.default;
  await TreeSitter.init();

  // Load the Python WASM grammar from tree-sitter-wasms package.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
  const wasmPath = path.join(wasmsDir, 'out', 'tree-sitter-python.wasm');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`tree-sitter-python.wasm not found at ${wasmPath}`);
  }

  PythonLanguage = await TreeSitter.Language.load(wasmPath);
}

interface PyProjectInternal {
  rootDir: string;
  repository: string;
}

const projectHandleBrand: unique symbol = Symbol('PyProjectHandle');

function makeHandle(internal: PyProjectInternal): ProjectHandle {
  return { [projectHandleBrand]: true, ...internal } as unknown as ProjectHandle;
}

function unwrapHandle(handle: ProjectHandle): PyProjectInternal {
  return handle as unknown as PyProjectInternal;
}

export class PyLanguagePlugin implements LanguagePlugin {
  readonly id = PY_PLUGIN_ID;
  readonly fileExtensions = PY_FILE_EXTENSIONS;

  private visitors: PyFrameworkVisitor[] = [];

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
    // Defense-in-depth: prevent path traversal even though file list is internally controlled.
    const safeRoot = internal.rootDir.endsWith(path.sep) ? internal.rootDir : internal.rootDir + path.sep;
    if (!absPath.startsWith(safeRoot) && absPath !== internal.rootDir) {
      throw new Error(`Path traversal denied: ${filePath}`);
    }
    const source = fs.readFileSync(absPath, 'utf-8');

    // TreeSitter is guaranteed non-null here — ensureParser() awaited in loadProject().
    const parser = new TreeSitter!();
    parser.setLanguage(PythonLanguage!);
    const tree = parser.parse(source);

    const { extractPythonFile } = await import('./extract-source-file.js');
    return extractPythonFile(
      tree,
      filePath,
      internal.repository,
      internal.rootDir,
      this.visitors
    );
  }

  registerVisitor(visitor: FrameworkVisitor): void {
    if (visitor.language !== 'py') {
      throw new Error(`PyLanguagePlugin: visitor language must be 'py', got '${visitor.language}'`);
    }
    this.visitors.push(visitor as PyFrameworkVisitor);
  }
}
