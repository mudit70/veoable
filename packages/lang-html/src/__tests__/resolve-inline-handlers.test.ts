import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { idFor, type FunctionDefinition, type SourceFile } from '@veoable/schema';
import { makeBatchMeta } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { extractCallNames, resolveInlineHandlers } from '../resolve-inline-handlers.js';

// ──────────────────────────────────────────────────────────────────────
// extractCallNames — regex-based JS call extraction
// ──────────────────────────────────────────────────────────────────────

describe('extractCallNames', () => {
  it('captures bare identifier calls', () => {
    expect(extractCallNames(`onclick="doLogin()"`)).toEqual(['doLogin']);
  });

  it('captures multiple sequential calls', () => {
    expect(extractCallNames(`onclick="track('signup'); openHelp()"`).sort())
      .toEqual(['openHelp', 'track']);
  });

  it('skips method calls (obj.method)', () => {
    expect(extractCallNames(`onclick="user.logout()"`)).toEqual([]);
    // The receiver `user` isn't followed by `(` so it's not captured either.
  });

  it('skips method calls but keeps the bare call before them', () => {
    expect(extractCallNames(`onclick="prepare(); user.logout()"`)).toEqual(['prepare']);
  });

  it('filters JS keywords (if, return, function, …)', () => {
    expect(extractCallNames(`onclick="if (validate()) doLogin()"`).sort())
      .toEqual(['doLogin', 'validate']);
    expect(extractCallNames(`onclick="return foo()"`)).toEqual(['foo']);
    expect(extractCallNames(`onclick="(function(){ bar(); })()"`)).toEqual(['bar']);
  });

  it('handles nested calls', () => {
    expect(extractCallNames(`onclick="outer(inner('x'))"`).sort())
      .toEqual(['inner', 'outer']);
  });

  it('returns empty for snippets without any calls', () => {
    expect(extractCallNames(`onclick=""`)).toEqual([]);
    expect(extractCallNames(`onclick="x = 1"`)).toEqual([]);
    expect(extractCallNames(`onclick="this.value"`)).toEqual([]);
  });

  it('deduplicates the same call name', () => {
    expect(extractCallNames(`onclick="track(); track();"`)).toEqual(['track']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveInlineHandlers — cross-file CALLS_FUNCTION emission
// ──────────────────────────────────────────────────────────────────────

const repo = 'html-resolve-test';

let store: SQLiteCanonicalGraphStore;

beforeEach(() => {
  store = new SQLiteCanonicalGraphStore(':memory:');
});

afterEach(() => {
  store.close();
});

/** Seed an HTML per-process synthetic fn whose evidence snippet contains JS calls. */
function seedHtmlPerProcessFn(snippet: string, line = 12): FunctionDefinition {
  const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/index.html' });
  const sourceFile: SourceFile = {
    nodeType: 'SourceFile',
    id: sourceFileId,
    filePath: 'src/index.html',
    repository: repo,
    language: 'html',
    framework: null,
  };
  const fn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId, name: `_button_click_L${line}_onclick`, sourceLine: line }),
    name: `_button_click_L${line}_onclick`,
    sourceFileId,
    sourceLine: line,
    parameters: [],
    returnType: null,
    isExported: false,
    isAsync: false,
    evidence: {
      filePath: 'src/index.html',
      lineStart: line,
      lineEnd: line,
      snippet,
      confidence: 'exact',
    },
  };
  store.commit({ nodes: [sourceFile, fn], edges: [] }, makeBatchMeta('test'));
  return fn;
}

/** Seed a real JS/TS function definition that the HTML resolver should match. */
function seedTsFn(name: string, filePath = 'src/handlers.ts', line = 1): FunctionDefinition {
  const sourceFileId = idFor.sourceFile({ repository: repo, filePath });
  const sourceFile: SourceFile = {
    nodeType: 'SourceFile',
    id: sourceFileId,
    filePath,
    repository: repo,
    language: 'ts',
    framework: null,
  };
  const fn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId, name, sourceLine: line }),
    name,
    sourceFileId,
    sourceLine: line,
    parameters: [],
    returnType: null,
    isExported: true,
    isAsync: false,
  };
  store.commit({ nodes: [sourceFile, fn], edges: [] }, makeBatchMeta('test'));
  return fn;
}

describe('resolveInlineHandlers', () => {
  it('emits CALLS_FUNCTION from HTML per-process fn to a matching TS fn in the same repo', () => {
    const handler = seedHtmlPerProcessFn(`onclick="doLogin()"`);
    const target = seedTsFn('doLogin');

    const batch = resolveInlineHandlers(store);

    expect(batch.edges).toHaveLength(1);
    const edge = batch.edges[0];
    expect(edge.edgeType).toBe('CALLS_FUNCTION');
    expect(edge.from).toBe(handler.id);
    expect(edge.to).toBe(target.id);
  });

  it('handles multiple calls in one snippet', () => {
    seedHtmlPerProcessFn(`onclick="track('x'); openHelp()"`);
    seedTsFn('track');
    seedTsFn('openHelp');

    const batch = resolveInlineHandlers(store);
    const targetNames = batch.edges.map((e) => {
      const fn = store.findNodes('FunctionDefinition').find((f) => f.id === e.to);
      return fn?.name;
    }).sort();
    expect(targetNames).toEqual(['openHelp', 'track']);
  });

  it('skips calls with no matching FunctionDefinition (silent dropout)', () => {
    seedHtmlPerProcessFn(`onclick="undefinedHandler()"`);
    // No matching TS fn seeded.

    const batch = resolveInlineHandlers(store);
    expect(batch.edges).toHaveLength(0);
  });

  it('does NOT match TS functions in a different repository', () => {
    seedHtmlPerProcessFn(`onclick="doLogin()"`);
    // doLogin lives in a different repo.
    const otherRepoFile = idFor.sourceFile({ repository: 'other-repo', filePath: 'src/other.ts' });
    store.commit({
      nodes: [
        { nodeType: 'SourceFile', id: otherRepoFile, filePath: 'src/other.ts', repository: 'other-repo', language: 'ts', framework: null },
        {
          nodeType: 'FunctionDefinition',
          id: idFor.functionDefinition({ sourceFileId: otherRepoFile, name: 'doLogin', sourceLine: 1 }),
          name: 'doLogin',
          sourceFileId: otherRepoFile,
          sourceLine: 1,
          parameters: [],
          returnType: null,
          isExported: true,
          isAsync: false,
        },
      ],
      edges: [],
    }, makeBatchMeta('test'));

    const batch = resolveInlineHandlers(store);
    expect(batch.edges).toHaveLength(0);
  });

  it('does NOT resolve into other HTML synthetic fns (form_submit / per-process)', () => {
    seedHtmlPerProcessFn(`onclick="_form_submit_L1()"`);
    // The resolver filters by name pattern (isHtmlSynthetic), not by file
    // language, so any fn matching the lang-html synthetic-fn naming
    // convention is excluded from the target index — even if such a name
    // somehow appeared in a TS source file.
    const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/index2.html' });
    store.commit({
      nodes: [
        { nodeType: 'SourceFile', id: sourceFileId, filePath: 'src/index2.html', repository: repo, language: 'html', framework: null },
        {
          nodeType: 'FunctionDefinition',
          id: idFor.functionDefinition({ sourceFileId, name: '_form_submit_L1', sourceLine: 1 }),
          name: '_form_submit_L1',
          sourceFileId,
          sourceLine: 1,
          parameters: [],
          returnType: null,
          isExported: false,
          isAsync: false,
        },
      ],
      edges: [],
    }, makeBatchMeta('test'));

    const batch = resolveInlineHandlers(store);
    expect(batch.edges).toHaveLength(0);
  });

  it('emits multiple edges when several FunctionDefinitions share the call name', () => {
    seedHtmlPerProcessFn(`onclick="login()"`);
    seedTsFn('login', 'src/auth.ts', 5);
    seedTsFn('login', 'src/legacy/auth.ts', 9);

    const batch = resolveInlineHandlers(store);
    expect(batch.edges).toHaveLength(2);
  });

  it('skips form_submit synthetic fns as sources (not just as targets)', () => {
    // Seed a form_submit fn whose snippet (theoretically) contains a call.
    // The resolver should not emit CALLS_FUNCTION from it — those represent
    // the form's MAKES_REQUEST machinery, not inline JS.
    const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/form.html' });
    const fn: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId, name: '_form_submit_L8', sourceLine: 8 }),
      name: '_form_submit_L8',
      sourceFileId,
      sourceLine: 8,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
      evidence: {
        filePath: 'src/form.html',
        lineStart: 8,
        lineEnd: 8,
        snippet: `<form action="/api" onsubmit="customSubmit()">`,
        confidence: 'exact',
      },
    };
    store.commit({
      nodes: [
        { nodeType: 'SourceFile', id: sourceFileId, filePath: 'src/form.html', repository: repo, language: 'html', framework: null },
        fn,
      ],
      edges: [],
    }, makeBatchMeta('test'));
    seedTsFn('customSubmit');

    const batch = resolveInlineHandlers(store);
    expect(batch.edges).toHaveLength(0);
  });

  it('resolves Vue bare-identifier handler refs (`@click="onSubmit"`)', () => {
    // The per-process fn's evidence snippet is the attribute text. For Vue
    // the value is just an identifier with no parens — extractCallNames
    // pattern 2 (BARE_VALUE_RE) handles this case.
    const sourceFileId = idFor.sourceFile({ repository: repo, filePath: 'src/Login.vue' });
    const sourceFile: SourceFile = {
      nodeType: 'SourceFile',
      id: sourceFileId,
      filePath: 'src/Login.vue',
      repository: repo,
      language: 'vue',
      framework: null,
    };
    const handler: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId, name: '_button_click_L7_@click', sourceLine: 7 }),
      name: '_button_click_L7_@click',
      sourceFileId,
      sourceLine: 7,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
      evidence: { filePath: 'src/Login.vue', lineStart: 7, lineEnd: 7, snippet: `@click="trackClick"`, confidence: 'exact' },
    };
    // Vue script-method stub — same file, real name (no underscore prefix).
    const target: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId, name: 'trackClick', sourceLine: 22 }),
      name: 'trackClick',
      sourceFileId,
      sourceLine: 22,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
    };
    store.commit({ nodes: [sourceFile, handler, target], edges: [] }, makeBatchMeta('test'));

    const batch = resolveInlineHandlers(store);
    expect(batch.edges).toHaveLength(1);
    expect(batch.edges[0].from).toBe(handler.id);
    expect(batch.edges[0].to).toBe(target.id);
  });

  it('resolves a Vue-script method stub call to a cross-file TS fn (Fix 5)', () => {
    // The Vue-script harvester stashes the method body on evidence.snippet
    // for non-synthetic FunctionDefinitions in .vue files. The resolver
    // should treat those just like per-process synthetic fns — scan the
    // snippet for call names and emit CALLS_FUNCTION to same-repo matches.
    const vueFileId = idFor.sourceFile({ repository: repo, filePath: 'src/OrderBook.vue' });
    const vueFile: SourceFile = {
      nodeType: 'SourceFile',
      id: vueFileId,
      filePath: 'src/OrderBook.vue',
      repository: repo,
      language: 'vue',
      framework: null,
    };
    const handleCancel: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId: vueFileId, name: 'handleCancel', sourceLine: 12 }),
      name: 'handleCancel',
      sourceFileId: vueFileId,
      sourceLine: 12,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
      evidence: {
        filePath: 'src/OrderBook.vue',
        lineStart: 12,
        lineEnd: 15,
        snippet: `  await cancelOrder(id);\n  await refresh();\n`,
        confidence: 'heuristic',
      },
    };
    store.commit({ nodes: [vueFile, handleCancel], edges: [] }, makeBatchMeta('test'));
    const cancelOrder = seedTsFn('cancelOrder', 'src/api/client.ts', 46);
    const refresh = seedTsFn('refresh', 'src/components/PortfolioView.vue.ts', 8);

    const batch = resolveInlineHandlers(store);

    const targetIds = batch.edges
      .filter((e) => e.from === handleCancel.id)
      .map((e) => e.to)
      .sort();
    expect(targetIds).toEqual([cancelOrder.id, refresh.id].sort());
  });

  it('does NOT emit a self-recursive CALLS_FUNCTION edge from a Vue stub', () => {
    // If a method body's snippet contains a recursive call, we should not
    // emit fn → fn — wastes BFS visits without adding signal.
    const vueFileId = idFor.sourceFile({ repository: repo, filePath: 'src/Recursive.vue' });
    const vueFile: SourceFile = {
      nodeType: 'SourceFile',
      id: vueFileId,
      filePath: 'src/Recursive.vue',
      repository: repo,
      language: 'vue',
      framework: null,
    };
    const fn: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId: vueFileId, name: 'tick', sourceLine: 1 }),
      name: 'tick',
      sourceFileId: vueFileId,
      sourceLine: 1,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
      evidence: { filePath: 'src/Recursive.vue', lineStart: 1, lineEnd: 3, snippet: 'tick(); tick();', confidence: 'heuristic' },
    };
    store.commit({ nodes: [vueFile, fn], edges: [] }, makeBatchMeta('test'));

    const batch = resolveInlineHandlers(store);
    expect(batch.edges).toHaveLength(0);
  });

  it('skips Vue stubs without evidence.snippet (no body extracted)', () => {
    // A Vue stub that the harvester couldn't brace-match (e.g., body lives
    // in a string literal that confuses the slicer) is emitted without
    // evidence — the resolver must not crash and must not emit edges.
    const vueFileId = idFor.sourceFile({ repository: repo, filePath: 'src/Stub.vue' });
    const vueFile: SourceFile = {
      nodeType: 'SourceFile',
      id: vueFileId,
      filePath: 'src/Stub.vue',
      repository: repo,
      language: 'vue',
      framework: null,
    };
    const fn: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId: vueFileId, name: 'doStuff', sourceLine: 1 }),
      name: 'doStuff',
      sourceFileId: vueFileId,
      sourceLine: 1,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
      // No evidence field.
    };
    store.commit({ nodes: [vueFile, fn], edges: [] }, makeBatchMeta('test'));
    seedTsFn('doStuff');

    const batch = resolveInlineHandlers(store);
    expect(batch.edges).toHaveLength(0);
  });

  it('end-to-end: process → per-process fn → CALLS_FUNCTION → TS fn', () => {
    // Realistic shape: emit the per-process fn through the extractor's
    // naming convention, then resolve. Verify the chain is walkable.
    const handler = seedHtmlPerProcessFn(`onclick="signup()"`);
    const target = seedTsFn('signup');

    const batch = resolveInlineHandlers(store);

    // After committing the resolver's edges, traverse from handler.
    store.commit(batch, makeBatchMeta('test'));
    const calls = store.findEdges(handler.id, null, 'CALLS_FUNCTION');
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(target.id);
  });
});
