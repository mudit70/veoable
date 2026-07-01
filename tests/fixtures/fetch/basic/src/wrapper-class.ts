// Wrapper-class call sites (#182, half A). Each method on a class
// whose body internally calls fetch should be detected at every USE
// SITE, not just where the wrapper is defined.

// The classic shape from the test-code-comprehension repo: a class
// with a parameter property `private url: string` and a `post()`
// method whose body builds a URL by interpolating `this.url` and a
// method parameter.
export class PostAPIClient {
  constructor(private url: string) {}
  async post(requestName: string, body: unknown) {
    return fetch(`${this.url}?r=${requestName}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}

// A wrapper that sets the field via a constructor body assignment,
// not a parameter property.
export class CtorAssignClient {
  private base: string;
  constructor(base: string) {
    this.base = base;
  }
  async get(path: string) {
    return fetch(`${this.base}${path}`);
  }
}

const apiJade = new PostAPIClient('/api/jade');
const apiAccount = new PostAPIClient('/api/account');
const ctorClient = new CtorAssignClient('https://example.com');

// Use sites — each should produce its own ClientSideAPICaller with
// the URL specialized using the call-site's first argument.
export async function generateBundle(body: unknown) {
  return apiJade.post('GenerateBundle', body);
}

export async function getBundle(id: string) {
  return apiJade.post('GetBundle', { id });
}

export async function getAccountData() {
  return apiAccount.post('GetAccountData', {});
}

// Dynamic first argument — request name comes from a variable. Should
// fall back to a `pattern` URL anchored at `${baseUrl}?r=`.
export async function postDynamic(name: string, body: unknown) {
  return apiJade.post(name, body);
}

// Non-fetch method on a wrapper class — must NOT match.
export class NotAWrapper {
  greet(name: string) {
    return `hello ${name}`;
  }
}
const greeter = new NotAWrapper();
greeter.greet('world');

// External-host call.
export async function externalGet(path: string) {
  return ctorClient.get(path);
}

// Real-world shape from the test-code-comprehension repo:
// destructured object constructor parameter, custom method name
// ("sendRequest" rather than a verb-like name), and the wrapper held
// as a field on another class.
export class DestructuredCtorClient<T extends Record<string, { Request: unknown; Response: unknown }>> {
  private url: string;
  constructor({ url }: { url: string }) {
    this.url = url;
  }
  async sendRequest<K extends keyof T>(requestName: K, body: T[K]['Request']): Promise<T[K]['Response']> {
    const response = await fetch(`${this.url}?r=${String(requestName)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.json();
  }
}

interface JadeApi extends Record<string, { Request: unknown; Response: unknown }> {
  GenerateBundle: { Request: unknown; Response: unknown };
}

class API {
  jade: DestructuredCtorClient<JadeApi>;
  constructor() {
    this.jade = new DestructuredCtorClient({ url: '/api/jade' });
  }
  async generateBundleViaApiClass(body: unknown) {
    return this.jade.sendRequest('GenerateBundle', body);
  }
}

// Make the class observable to the visitor.
export const apiInstance = new API();

