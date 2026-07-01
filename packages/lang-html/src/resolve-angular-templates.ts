import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanonicalGraphStore } from '@adorable/graph-db';
import type { NodeBatch } from '@adorable/plugin-api';
import type { CallsFunctionEdge, FunctionDefinition, SchemaEdge, SourceFile } from '@adorable/schema';
import { extractCallNames } from './resolve-inline-handlers.js';
import { isPerProcessSynthetic } from './synthetic-names.js';

/**
 * Resolve Angular template handler bindings to their component-class methods
 * (#173 piece C).
 *
 * lang-ts has already extracted Angular component classes with their methods
 * named `<ClassName>.<methodName>` (e.g., `LoginComponent.onSubmit`). lang-html
 * has emitted per-process synthetic fns for each `(event)="..."` template
 * binding. This pass connects the two by:
 *
 *   1. Reading every `.ts` file in the graph from disk to find
 *      `@Component({ ..., templateUrl: '...' })` decorators paired with a
 *      class declaration.
 *   2. Resolving the relative `templateUrl` to a SourceFile in the graph.
 *   3. For each per-process synthetic fn in that template's SourceFile,
 *      extracting bare identifier calls from its snippet and emitting
 *      CALLS_FUNCTION edges to `<ClassName>.<callName>` definitions.
 *
 * The flow walker can then chain
 *
 *   process → per-process fn → CALLS_FUNCTION → ClassName.method → ... → caller
 *
 * Requires `rootDir` because the graph store doesn't carry raw file
 * contents — `templateUrl` strings live inline in TS source.
 *
 * Limitations (#173 follow-ups):
 *   - Inline `template: '...'` (instead of `templateUrl`) is not handled.
 *     Those templates are JS strings inside the TS file rather than separate
 *     HTML files in the graph.
 *   - Method-call expressions like `obj.method()` are skipped (same as
 *     piece B's regex parser).
 *   - Multi-repo projects with separate roots are not supported here —
 *     pass each repo's rootDir if you need that.
 */
export function resolveAngularTemplates(
  store: CanonicalGraphStore,
  rootDir: string,
): NodeBatch {
  const newEdges: SchemaEdge[] = [];

  const allSourceFiles = store.findNodes('SourceFile') as SourceFile[];
  const allFns = store.findNodes('FunctionDefinition') as FunctionDefinition[];

  // Pre-built indices so the per-decoration loop is O(1) per lookup.
  // - `fnByName`: target lookup by `<ClassName>.<callName>`.
  // - `perProcessFnsByFileId`: per-process synthetic fns grouped by their
  //   template SourceFile, so we don't linearly scan all functions for
  //   every component decoration.
  // - `sfByPosixPath`: filePath → SourceFile for templateUrl resolution.
  const fnByName = new Map<string, FunctionDefinition[]>();
  const perProcessFnsByFileId = new Map<string, FunctionDefinition[]>();
  for (const fn of allFns) {
    let list = fnByName.get(fn.name);
    if (!list) { list = []; fnByName.set(fn.name, list); }
    list.push(fn);

    if (isPerProcessSynthetic(fn.name)) {
      let bucket = perProcessFnsByFileId.get(fn.sourceFileId);
      if (!bucket) { bucket = []; perProcessFnsByFileId.set(fn.sourceFileId, bucket); }
      bucket.push(fn);
    }
  }
  const sfByPosixPath = new Map<string, SourceFile>();
  for (const sf of allSourceFiles) sfByPosixPath.set(sf.filePath, sf);

  // Walk every TS file in the graph; harvest @Component templateUrl mappings.
  for (const sf of allSourceFiles) {
    if (sf.language !== 'ts') continue;
    const absPath = path.resolve(rootDir, sf.filePath);
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue; // File moved or unreadable — skip.
    }
    // Cheap pre-filter: skip the regex (and the per-decoration loop) on
    // files that obviously aren't Angular components. Saves the regex
    // engine on TS-heavy non-Angular projects.
    if (!source.includes('@Component')) continue;

    for (const { templateRelative, className } of findComponentDecorators(source)) {
      // Resolve templateUrl relative to the TS file's directory.
      const tsDir = path.dirname(sf.filePath);
      const templateRel = path
        .normalize(path.join(tsDir, templateRelative))
        .split(path.sep)
        .join('/');
      const templateSf = sfByPosixPath.get(templateRel);
      if (!templateSf) continue;

      // O(1) lookup of per-process fns in this template's source file.
      const perProcessFns = perProcessFnsByFileId.get(templateSf.id);
      if (!perProcessFns) continue;

      for (const fn of perProcessFns) {
        const callNames = extractCallNames(fn.evidence?.snippet ?? '');
        for (const callName of callNames) {
          const targets = fnByName.get(`${className}.${callName}`);
          if (!targets) continue;
          for (const target of targets) {
            newEdges.push({
              edgeType: 'CALLS_FUNCTION',
              from: fn.id,
              to: target.id,
              sourceLine: fn.sourceLine,
              arguments: [],
              isConditional: false,
              confidence: 'direct',
            } as CallsFunctionEdge);
          }
        }
      }
    }
  }

  return { nodes: [], edges: newEdges };
}

interface ComponentDecoration {
  templateRelative: string;
  className: string;
}

/**
 * Find `@Component({ ..., templateUrl: '...' })` decorators paired with
 * the class declaration that immediately follows. Regex-based — handles
 * the common patterns; ts-morph would be more precise but adds a runtime
 * dep just for this lookup.
 *
 * Recognized:
 *   `@Component({ templateUrl: './foo.html' }) export class FooComponent { ... }`
 *   `@Component({\n  templateUrl: "foo.html",\n  selector: 'x' })\nclass Foo { ... }`
 *
 * Not handled (out of scope for #173):
 *   - Inline `template: '...'` strings.
 *   - templateUrl interpolated from a constant.
 *   - Class names that span multiple decorators (rare).
 */
function findComponentDecorators(source: string): ComponentDecoration[] {
  const out: ComponentDecoration[] = [];
  // The regex below matches `@Component({...})` followed by an optional
  // export modifier, the `class` keyword, and the class name.
  // Decorator body uses a non-greedy match so we don't gobble across components.
  const RE = /@Component\s*\(\s*\{([\s\S]*?)\}\s*\)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(source)) !== null) {
    const body = m[1];
    const className = m[2];
    const tplMatch = /templateUrl\s*:\s*['"`]([^'"`]+)['"`]/.exec(body);
    if (!tplMatch) continue;
    out.push({ templateRelative: tplMatch[1], className });
  }
  return out;
}
