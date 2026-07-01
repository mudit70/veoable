// #196 — URL-builder method fixture.
// Methods that return a URL template are also "API callers" — even
// though they don't call fetch() themselves, the returned URL is
// later used by `<a href>` or `window.location.assign(...)` for an
// actual GET request to the server.

class DownloadAPI {
  constructor(public base: string) {}

  // Path-relative URL — the most common shape. Uses `this.base` so
  // the wrapper-resolver substitution path exercises both `this.<f>`
  // and method-param resolution.
  generateJadeDownloadUrl(id: number): string {
    return `${this.base}/jade?id=${id}`;
  }

  // Different endpoint, same builder shape.
  generateBundleDownloadUrl(id: number): string {
    return `/api/jade/jadb?id=${id}`;
  }

  // Fully qualified — works the same.
  generateExternalDownloadUrl(name: string): string {
    return `https://cdn.example.com/files/${name}.zip`;
  }

  // Non-URL return (label, JSON blob, etc.) — must NOT be detected.
  formatDisplayLabel(name: string): string {
    return `User: ${name}`;
  }
}

const api = new DownloadAPI('/api/jade');

// Three call sites — each should emit a ClientSideAPICaller via the
// extended wrapper-resolver.
export function startJadeDownload(id: number): string {
  return api.generateJadeDownloadUrl(id);
}

export function startBundleDownload(id: number): string {
  return api.generateBundleDownloadUrl(id);
}

export function externalDownloadUrl(name: string): string {
  return api.generateExternalDownloadUrl(name);
}

// This call should NOT emit (non-URL return).
export function userLabel(name: string): string {
  return api.formatDisplayLabel(name);
}
