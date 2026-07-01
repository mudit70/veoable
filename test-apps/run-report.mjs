#!/usr/bin/env node
// Drives `adorable analyze` over each test-apps subdirectory and prints a
// per-app coverage report: detected plugins, node counts by type, stitch
// outcomes, and flow shape.
//
// Run from the repo root:   node test-apps/run-report.mjs
import { analyze } from '../packages/cli/dist/index.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const APPS = [
  {
    id: '01-task-tracker',
    expect: {
      frontend: ['nextjs', 'react', 'fetch'],
      backend: ['fastapi'],
      data: ['sqlalchemy'],
    },
  },
  {
    id: '02-fleet-monitor',
    expect: {
      frontend: ['react', 'axios'],
      backend: ['gin'],
      data: ['mongogo'],
    },
  },
  {
    id: '03-content-cms',
    expect: {
      frontend: ['svelte', 'fetch'],
      backend: ['nestjs'],
      data: ['prisma', 'ioredis'],
    },
  },
  {
    id: '04-trading-dash',
    expect: {
      frontend: ['vue', 'fetch'],
      backend: ['axum'],
      // awsrust-s3 is the plugin id (it covers all 5 AWS services as of
      // Phase 5u); apalis runs the SQS-fed background worker. The
      // per-service framework labels (awsrust-dynamodb / awsrust-sqs)
      // live on emitted nodes, not in the detected-plugin list.
      data: ['awsrust-s3', 'apalis'],
    },
  },
  {
    id: '05-photo-share',
    expect: {
      frontend: ['react-native', 'fetch'],
      backend: ['django'],
      data: ['boto3-s3', 'redispy'],
    },
  },
];

const COUNTED_NODE_TYPES = [
  'APIEndpoint',
  'ClientSideAPICaller',
  'DatabaseInteraction',
  'DatabaseTable',
  'DatabaseSystem',
  'FunctionDefinition',
  'SourceFile',
  'Repository',
  'ClientSideProcess',
  'Screen',
  'Page',
];

function nodeCountsByType(store) {
  const out = {};
  for (const t of COUNTED_NODE_TYPES) {
    const n = store.findNodes(t).length;
    if (n) out[t] = n;
  }
  return out;
}

function frameworksByNodeType(store) {
  const out = {};
  for (const t of ['APIEndpoint', 'ClientSideAPICaller', 'DatabaseInteraction', 'DatabaseSystem', 'ClientSideProcess']) {
    const nodes = store.findNodes(t);
    const tally = {};
    for (const n of nodes) {
      const fw = n.framework ?? '(none)';
      tally[fw] = (tally[fw] ?? 0) + 1;
    }
    if (Object.keys(tally).length) out[t] = tally;
  }
  return out;
}

function endpointRoutes(store) {
  return store.findNodes('APIEndpoint').map((n) => ({
    rp: n.routePattern,
    m: n.httpMethod,
    fw: n.framework,
  }));
}

function callerUrls(store) {
  return store.findNodes('ClientSideAPICaller').map((n) => ({
    u: n.urlLiteral,
    m: n.httpMethod,
    fw: n.framework,
  }));
}

function dbInteractions(store) {
  // DatabaseInteraction carries `orm` (and `operation`), not `framework`.
  const nodes = store.findNodes('DatabaseInteraction');
  const tally = new Map();
  for (const n of nodes) {
    const orm = n.orm ?? '(none)';
    const op = n.operation ?? '?';
    const key = `${orm}|${op}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally.entries()].map(([k, n]) => {
    const [fw, verb] = k.split('|');
    return { fw, verb, n };
  });
}

async function runApp(app) {
  const rootDir = path.join(repoRoot, 'test-apps', app.id);
  const result = await analyze({ rootDir, repoName: app.id });
  const store = result.store;

  const detected = result.detectedPlugins;
  const emitting = result.emittingPlugins;
  const expected = [...app.expect.frontend, ...app.expect.backend, ...app.expect.data];
  const missing = expected.filter((p) => !detected.includes(p));
  // #523 item 3 — the user-facing "unexpected detections" warning
  // should only fire for plugins that actually contributed nodes.
  // Plugins that activate-but-emit-nothing are already filtered out
  // of `emittingPlugins` at the analyzer layer, so no manual
  // whitelist is needed here anymore.
  const unexpected = emitting.filter((p) => !expected.includes(p));

  return {
    app: app.id,
    sourceFileCount: result.sourceFileCount,
    detectedPlugins: detected,
    emittingPlugins: emitting,
    expectedPlugins: expected,
    missingExpected: missing,
    unexpectedDetections: unexpected,
    schemaSummary: result.schemaSummary,
    stitchSummary: result.stitchSummary,
    completeFlowCount: result.completeFlowCount,
    partialFlowCount: result.partialFlowCount,
    nodeCounts: nodeCountsByType(store),
    frameworks: frameworksByNodeType(store),
    endpoints: endpointRoutes(store),
    callers: callerUrls(store),
    dbInteractions: dbInteractions(store),
  };
}

function fmtCounts(counts) {
  if (Object.keys(counts).length === 0) return '(none)';
  return Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
}

(async () => {
  const reports = [];
  for (const app of APPS) {
    process.stdout.write(`Analyzing ${app.id}...\n`);
    try {
      reports.push(await runApp(app));
    } catch (err) {
      reports.push({ app: app.id, error: String(err.stack || err) });
    }
  }

  // Markdown report
  const md = ['# Adorable test-apps coverage report', ''];
  md.push(`Generated by \`test-apps/run-report.mjs\`.`);
  md.push('');
  md.push('| App | Files | Detected plugins | Missing | Unexpected | Endpoints | Callers | DB ops | Complete flows | Partial |');
  md.push('|-----|-------|------------------|---------|------------|-----------|---------|--------|----------------|---------|');
  for (const r of reports) {
    if (r.error) {
      md.push(`| ${r.app} | — | error | — | — | — | — | — | — | — |`);
      continue;
    }
    md.push(
      `| ${r.app} | ${r.sourceFileCount} | ${r.detectedPlugins.length} | ${r.missingExpected.length} | ${r.unexpectedDetections.length} | ${r.endpoints.length} | ${r.callers.length} | ${r.dbInteractions.length} | ${r.completeFlowCount} | ${r.partialFlowCount} |`,
    );
  }
  md.push('');

  for (const r of reports) {
    md.push(`## ${r.app}`);
    if (r.error) {
      md.push(`\n**Error:**\n\n\`\`\`\n${r.error}\n\`\`\`\n`);
      continue;
    }
    md.push('');
    md.push(`**Source files scanned:** ${r.sourceFileCount}`);
    md.push('');
    md.push(`**Detected plugins:** ${r.detectedPlugins.join(', ') || '(none)'}`);
    md.push('');
    if (r.missingExpected.length) md.push(`**Missing expected:** ${r.missingExpected.join(', ')}`);
    if (r.unexpectedDetections.length) md.push(`**Unexpected detections:** ${r.unexpectedDetections.join(', ')}`);
    md.push('');
    md.push(`**Schema summary:** systems=${r.schemaSummary.systems} tables=${r.schemaSummary.tables} columns=${r.schemaSummary.columns}`);
    md.push(`**Stitch summary:** resolved=${r.stitchSummary.resolved} dynamic=${r.stitchSummary.dynamic}`);
    md.push(`**Flows:** ${r.completeFlowCount} complete, ${r.partialFlowCount} partial`);
    md.push('');
    md.push(`**Node counts:** ${fmtCounts(r.nodeCounts)}`);
    md.push('');

    if (r.endpoints.length) {
      md.push('**APIEndpoints:**');
      md.push('');
      for (const e of r.endpoints) {
        md.push(`- \`${e.m || '?'} ${e.rp || '?'}\` _(framework: ${e.fw || '?'})_`);
      }
      md.push('');
    }
    if (r.callers.length) {
      md.push('**ClientSideAPICallers:**');
      md.push('');
      for (const c of r.callers) {
        md.push(`- \`${c.m || '?'} ${c.u || '?'}\` _(framework: ${c.fw || '?'})_`);
      }
      md.push('');
    }
    if (r.dbInteractions.length) {
      md.push('**DatabaseInteractions:**');
      md.push('');
      for (const d of r.dbInteractions) {
        md.push(`- ${d.fw}: \`${d.verb}\` × ${d.n}`);
      }
      md.push('');
    }
  }

  const outPath = path.join(__dirname, 'REPORT.md');
  fs.writeFileSync(outPath, md.join('\n'));
  console.log(`\nWrote ${outPath}`);

  // Machine-readable JSON sidecar
  const jsonPath = path.join(__dirname, 'report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(reports, null, 2));
  console.log(`Wrote ${jsonPath}`);
})();
