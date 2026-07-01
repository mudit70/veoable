/**
 * Per-framework fixture suite tests (#33).
 *
 * Automatically discovers all fixture directories under fixtures/,
 * runs each through the test harness, and asserts that detected
 * endpoints match the expected.json.
 *
 * Minor fix: each fixture is run once and results are shared across
 * all assertions for that fixture.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import { runFixture, assertEndpointsMatch, assertNoNegatives, assertSchemaValid } from './harness/runner.js';
import type { APIEndpoint } from '@adorable/schema';
import type { ExpectedDetectionResult } from './harness/types.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_ROOT = path.resolve(__dirname, 'fixtures');

function discoverFixtures(): Array<{ name: string; dir: string }> {
  const fixtures: Array<{ name: string; dir: string }> = [];
  if (!fs.existsSync(FIXTURES_ROOT)) return fixtures;

  for (const framework of fs.readdirSync(FIXTURES_ROOT, { withFileTypes: true })) {
    if (!framework.isDirectory()) continue;
    for (const testCase of fs.readdirSync(path.join(FIXTURES_ROOT, framework.name), { withFileTypes: true })) {
      if (!testCase.isDirectory()) continue;
      const fixtureDir = path.join(FIXTURES_ROOT, framework.name, testCase.name);
      if (fs.existsSync(path.join(fixtureDir, 'expected.json')) &&
          fs.existsSync(path.join(fixtureDir, 'input'))) {
        fixtures.push({ name: `${framework.name}/${testCase.name}`, dir: fixtureDir });
      }
    }
  }
  return fixtures.sort((a, b) => a.name.localeCompare(b.name));
}

const fixtures = discoverFixtures();

describe('endpoint detection fixtures (#33)', () => {
  if (fixtures.length === 0) {
    it.skip('no fixtures found', () => {});
    return;
  }

  // Minor fix: run each fixture once and share results
  describe.each(fixtures)('$name', ({ dir }) => {
    let endpoints: APIEndpoint[];
    let expected: ExpectedDetectionResult;

    beforeAll(async () => {
      const result = await runFixture(dir);
      endpoints = result.endpoints;
      expected = result.expected;
    });

    it('detects all expected endpoints (bidirectional)', () => {
      assertEndpointsMatch(endpoints, expected.endpoints);
    });

    it('all endpoints pass schema validation', () => {
      assertSchemaValid(endpoints);
    });

    it('sets correct framework on all endpoints', () => {
      for (const ep of endpoints) {
        expect(ep.framework).toBe(expected.pluginId);
      }
    });

    it('does not detect negative patterns', () => {
      if (expected.negativePatterns && expected.negativePatterns.length > 0) {
        assertNoNegatives(endpoints, expected.negativePatterns);
      }
    });
  });
});
