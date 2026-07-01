import axios from 'axios';

// 1. Bare axios — no base URL, just the literal arg.
export async function listUsersBare() {
  return axios.get('/api/users');
}

// 2. axios.create with literal baseURL, used at top of file.
const api = axios.create({ baseURL: '/api/v1' });

export async function listUsersInstance() {
  return api.get('/users');
}

export async function createUserInstance(body: unknown) {
  return api.post('/users', body);
}

export async function getUserById(id: string) {
  return api.get(`/users/${id}`);
}

// 3. axios.create with HTTPS baseURL — exercises slash normalization
//    and absolute-URL composition.
const external = axios.create({ baseURL: 'https://api.example.com' });

export async function listVendors() {
  return external.get('/v2/vendors');
}

// 4. Trailing slash on baseURL + leading slash on path.
const trailing = axios.create({ baseURL: '/api/v1/' });

export async function listOrgsTrailing() {
  return trailing.get('/orgs');
}

// 5. No leading slash on path.
const noSlash = axios.create({ baseURL: '/api/v1' });

export async function listProjectsNoSlash() {
  return noSlash.get('projects');
}

// 6. axios.create called with `withCredentials: true` only (no baseURL).
//    Compose path should be the path itself.
const sessioned = axios.create({ withCredentials: true });

export async function getSession() {
  return sessioned.get('/session');
}

// 7. axios.create where baseURL is a non-literal (identifier).
const BASE = '/api/v3';
const fromConst = axios.create({ baseURL: BASE });

export async function listAccounts() {
  return fromConst.get('/accounts');
}

// 8. Cross-file scenario — see clients.ts + uses-client.ts.
