import type { Flow, FlowDatabaseHop } from '@veoable/flow-stitcher';
import type { AnalysisResult } from './analyze.js';

/**
 * Format an `AnalysisResult` as human-readable text for stdout.
 *
 * Note: source file locations currently display the raw `sourceFileId`
 * hash (e.g. `f15b91a192e97c76:19`) rather than a human-readable file
 * path. Resolving the path from the `SourceFile` node in the store is
 * a known UX gap tracked for a follow-up.
 */
export function formatText(result: AnalysisResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`Adorable analysis: ${result.rootDir}`);
  lines.push(`${'─'.repeat(60)}`);
  lines.push(`Source files:  ${result.sourceFileCount}`);
  // The user-facing "Frameworks" line shows the working set (plugins
  // that actually emitted graph nodes). If any detected plugins were
  // silent — activated by their detection signal but contributed no
  // nodes for this project — call them out separately so the headline
  // doesn't lie about what's actually wired up (#523 item 3).
  lines.push(`Frameworks:    ${result.emittingPlugins.join(', ') || 'none'}`);
  const silent = result.detectedPlugins.filter((p) => !result.emittingPlugins.includes(p));
  if (silent.length > 0) {
    lines.push(`  (detected, silent: ${silent.join(', ')})`);
  }

  if (result.schemaSummary.tables > 0) {
    lines.push(
      `DB schema:     ${result.schemaSummary.systems} system(s), ` +
        `${result.schemaSummary.tables} table(s), ` +
        `${result.schemaSummary.columns} column(s)`
    );
  }

  lines.push(
    `Stitching:     ${result.stitchSummary.resolved} resolved, ` +
      `${result.stitchSummary.dynamic} dynamic (deferred)`
  );
  lines.push(
    `Flows:         ${result.completeFlowCount} complete, ` +
      `${result.partialFlowCount} partial`
  );
  lines.push('');

  if (result.flows.length === 0) {
    lines.push('No flows found.');
    return lines.join('\n');
  }

  lines.push('End-to-end flows:');
  lines.push('');

  // Group flows by start process for readability.
  const byProcess = new Map<string, Flow[]>();
  for (const flow of result.flows) {
    const key = flow.startProcess.id;
    if (!byProcess.has(key)) byProcess.set(key, []);
    byProcess.get(key)!.push(flow);
  }

  let flowIndex = 1;
  for (const [, processFlows] of byProcess) {
    for (const flow of processFlows) {
      lines.push(formatFlow(flow, flowIndex));
      flowIndex += 1;
    }
  }

  return lines.join('\n');
}

function formatFlow(flow: Flow, index: number): string {
  const lines: string[] = [];
  const indent = '     ';
  const proc = flow.startProcess;

  lines.push(
    `  ${index}. ${proc.kind} "${proc.name}" (${proc.sourceFileId.replace(/^SourceFile:/, '')}:${proc.sourceLine})`
  );

  if (flow.caller) {
    const c = flow.caller;
    const method = c.httpMethod ?? '???';
    const url = c.urlLiteral ?? '<dynamic>';
    lines.push(`${indent}→ ${c.framework} ${method} ${url} [${c.egressConfidence}]`);
  }

  if (flow.endpoint) {
    const e = flow.endpoint;
    const conf = flow.matchConfidence ?? '?';
    const by = flow.matchedBy ?? '?';
    lines.push(`${indent}→ ${e.httpMethod} ${e.routePattern} [${conf}, ${by}]`);
  }

  if (flow.handlerFunction) {
    lines.push(`${indent}→ ${flow.handlerFunction.name}()`);
  }

  if (flow.databaseHops.length > 0) {
    for (const hop of flow.databaseHops) {
      lines.push(`${indent}→ ${formatDbHop(hop)}`);
    }
  }

  if (flow.completeness !== 'complete') {
    lines.push(`${indent}✗ stopped at: ${flow.completeness}`);
  }

  lines.push('');
  return lines.join('\n');
}

function formatDbHop(hop: FlowDatabaseHop): string {
  const op = hop.interaction.operation;
  const orm = hop.interaction.orm;
  const table = hop.readsTable?.name ?? hop.writesTable?.name ?? '<raw>';
  return `${orm} → ${table} [${op}]`;
}

/**
 * Format an `AnalysisResult` as machine-readable JSON.
 */
export function formatJson(result: AnalysisResult): string {
  return JSON.stringify(
    {
      rootDir: result.rootDir,
      sourceFileCount: result.sourceFileCount,
      detectedPlugins: result.detectedPlugins,
      emittingPlugins: result.emittingPlugins,
      schemaSummary: result.schemaSummary,
      stitchSummary: result.stitchSummary,
      completeFlowCount: result.completeFlowCount,
      partialFlowCount: result.partialFlowCount,
      flows: result.flows,
    },
    null,
    2
  );
}
