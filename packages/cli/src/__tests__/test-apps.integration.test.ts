import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, type AnalysisResult } from '../analyze.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Polyglot test apps live at repo-root /test-apps. Each app is a
// frontend / backend / database trio that exercises a specific
// combination of plugins (see test-apps/README.md and FINDINGS.md).
//
// These tests lock in:
//   - which framework plugins activate per app
//   - the minimum number of APIEndpoints and ClientSideAPICallers
//     each plugin should produce
//   - that analyze() does not throw on any app
//
// Soft thresholds are used (>=) rather than exact matches so that
// improvements in stitcher / plugin coverage don't break the test;
// regressions still do.

const TEST_APPS_ROOT = path.resolve(__dirname, '../../../../test-apps');

const APPS = [
  {
    id: '01-task-tracker',
    requiredPlugins: ['nextjs', 'react', 'fetch', 'fastapi', 'sqlalchemy'],
    minEndpoints: 6,
    minCallers: 5,
    endpointFrameworks: ['fastapi'],
    callerFrameworks: ['fetch'],
  },
  {
    id: '02-fleet-monitor',
    requiredPlugins: ['react', 'axios', 'gin', 'mongogo'],
    minEndpoints: 6,
    minCallers: 4,
    endpointFrameworks: ['gin'],
    callerFrameworks: ['axios'],
  },
  {
    id: '03-content-cms',
    requiredPlugins: ['svelte', 'nestjs', 'prisma', 'ioredis', 'fetch'],
    minEndpoints: 6,
    minCallers: 4,
    endpointFrameworks: ['nestjs'],
    callerFrameworks: ['fetch'],
    // Prisma yields >=2 DatabaseTable nodes (Article + Author) and >=2 DatabaseSystem nodes.
    minTables: 2,
    minSystems: 2,
  },
  {
    id: '04-trading-dash',
    requiredPlugins: ['vue', 'fetch', 'axum', 'awsrust-s3', 'apalis'],
    minEndpoints: 5,
    minCallers: 8,
    endpointFrameworks: ['axum'],
    // AWS Phase 5u: the same awsrust-s3 plugin emits per-service frameworks.
    callerFrameworks: ['fetch', 'awsrust-dynamodb', 'awsrust-sqs'],
  },
  {
    id: '05-photo-share',
    requiredPlugins: ['react-native', 'django', 'boto3-s3', 'redispy', 'fetch'],
    // After Iter 1: Django @api_view decorator support landed.
    // 5 endpoints expected: GET /api/photos, POST /api/photos,
    // POST /api/photos/upload-url, GET /api/photos/:photo_id,
    // DELETE /api/photos/:photo_id.
    minEndpoints: 5,
    minCallers: 8,
    endpointFrameworks: ['django'],
    callerFrameworks: ['fetch', 'boto3-s3'],
  },
] as const;

async function analyzeApp(id: string): Promise<AnalysisResult> {
  return analyze({ rootDir: path.join(TEST_APPS_ROOT, id), repoName: id });
}

function frameworkSetByType(store: AnalysisResult['store'], nodeType: 'APIEndpoint' | 'ClientSideAPICaller'): Set<string> {
  const nodes = store.findNodes(nodeType) as Array<{ framework?: string | null }>;
  return new Set(nodes.map((n) => n.framework ?? '').filter(Boolean));
}

describe('test-apps integration', () => {
  for (const app of APPS) {
    describe(app.id, () => {
      let result: AnalysisResult;

      it('analyze() completes without throwing', async () => {
        result = await analyzeApp(app.id);
        expect(result).toBeDefined();
        expect(result.sourceFileCount).toBeGreaterThan(0);
      });

      it('detects every required plugin', async () => {
        result ??= await analyzeApp(app.id);
        for (const plugin of app.requiredPlugins) {
          expect(result.detectedPlugins, `missing plugin "${plugin}"`).toContain(plugin);
        }
      });

      it('emits enough APIEndpoint nodes', async () => {
        result ??= await analyzeApp(app.id);
        const endpoints = result.store.findNodes('APIEndpoint');
        expect(endpoints.length, `expected >=${app.minEndpoints} endpoints`).toBeGreaterThanOrEqual(app.minEndpoints);
      });

      it('emits enough ClientSideAPICaller nodes', async () => {
        result ??= await analyzeApp(app.id);
        const callers = result.store.findNodes('ClientSideAPICaller');
        expect(callers.length, `expected >=${app.minCallers} callers`).toBeGreaterThanOrEqual(app.minCallers);
      });

      it('emits endpoints with the expected backend framework label', async () => {
        result ??= await analyzeApp(app.id);
        if (!app.endpointFrameworks?.length) return;
        const frameworks = frameworkSetByType(result.store, 'APIEndpoint');
        for (const fw of app.endpointFrameworks) {
          expect(frameworks, `missing endpoint framework "${fw}"`).toContain(fw);
        }
      });

      it('emits callers with the expected client framework labels', async () => {
        result ??= await analyzeApp(app.id);
        if (!app.callerFrameworks?.length) return;
        const frameworks = frameworkSetByType(result.store, 'ClientSideAPICaller');
        for (const fw of app.callerFrameworks) {
          expect(frameworks, `missing caller framework "${fw}"`).toContain(fw);
        }
      });

      if ('minTables' in app) {
        it('emits enough DatabaseTable nodes', async () => {
          result ??= await analyzeApp(app.id);
          const tables = result.store.findNodes('DatabaseTable');
          expect(tables.length, `expected >=${app.minTables} tables`).toBeGreaterThanOrEqual(app.minTables);
        });

        it('emits enough DatabaseSystem nodes', async () => {
          result ??= await analyzeApp(app.id);
          const systems = result.store.findNodes('DatabaseSystem');
          expect(systems.length, `expected >=${app.minSystems} systems`).toBeGreaterThanOrEqual(app.minSystems);
        });
      }
    });
  }
});
