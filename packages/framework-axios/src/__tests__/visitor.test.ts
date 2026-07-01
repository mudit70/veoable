import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { type ClientSideAPICaller, type SchemaNode } from '@adorable/schema';
import { type NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { AxiosPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/axios');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const plugin = new AxiosPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function callers(batch: { nodes: SchemaNode[] }): ClientSideAPICaller[] {
  return batch.nodes.filter(
    (n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller',
  );
}

function findCallerByFunction(
  batch: { nodes: SchemaNode[] },
  fnName: string,
): ClientSideAPICaller | undefined {
  const fn = batch.nodes.find((n) => n.nodeType === 'FunctionDefinition' && n.name === fnName);
  if (!fn) return undefined;
  return callers(batch).find((c) => c.functionId === fn.id);
}

describe('axios visitor — base behavior (regression pin)', () => {
  it('bare axios.get keeps the URL exactly as written (no baseURL composition)', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'listUsersBare');
    expect(caller).toBeDefined();
    expect(caller!.httpMethod).toBe('GET');
    expect(caller!.urlLiteral).toBe('/api/users');
    expect(caller!.egressConfidence).toBe('exact');
  });
});

describe('axios.create({ baseURL }) composition (#532)', () => {
  it('same-file `api = axios.create({ baseURL: "/api/v1" })` composes onto `api.get("/users")`', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'listUsersInstance');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/v1/users');
    expect(caller!.httpMethod).toBe('GET');
    expect(caller!.egressConfidence).toBe('exact');
  });

  it('POST through an instance composes the same way and preserves method', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'createUserInstance');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/v1/users');
    expect(caller!.httpMethod).toBe('POST');
  });

  it('template-URL call composes baseURL into templateParts[0] (stitcher fast-path)', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'getUserById');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/v1/users/:p0');
    expect(caller!.egressConfidence).toBe('pattern');
    expect(caller!.templateParts).toEqual(['/api/v1/users/', '']);
  });

  it('absolute https baseURL composes correctly', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'listVendors');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('https://api.example.com/v2/vendors');
  });

  it('trailing slash on baseURL + leading slash on path collapses to one slash', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'listOrgsTrailing');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/v1/orgs');
  });

  it('path without leading slash is joined with a single slash', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'listProjectsNoSlash');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/v1/projects');
  });

  it('axios.create({ withCredentials: true }) — no baseURL → path stays unchanged', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'getSession');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/session');
  });

  it('baseURL value is an identifier-bound string constant — resolves via resolveToString', async () => {
    const batch = await extract('basic', 'src/callers.ts');
    const caller = findCallerByFunction(batch, 'listAccounts');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/v3/accounts');
  });

  it('cross-file: imported `billingApi` resolves to its `axios.create` declaration', async () => {
    const batch = await extract('basic', 'src/uses-client.ts');
    const caller = findCallerByFunction(batch, 'listInvoices');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/billing/invoices');
  });

  it('cross-file template URL composes through the imported baseURL', async () => {
    const batch = await extract('basic', 'src/uses-client.ts');
    const caller = findCallerByFunction(batch, 'getInvoiceById');
    expect(caller).toBeDefined();
    expect(caller!.urlLiteral).toBe('/api/billing/invoices/:p0');
    expect(caller!.templateParts).toEqual(['/api/billing/invoices/', '']);
  });
});
