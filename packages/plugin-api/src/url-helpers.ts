/**
 * Classify a URL as external (public internet) vs internal (private
 * network, localhost, service-mesh hostname).
 *
 * Used by HTTP-client framework plugins (axios, fetch, reqwest, httpx,
 * ...) to stamp `isExternal` + `externalHost` on every emitted
 * ClientSideAPICaller. The MCP REST server's external-call views
 * (`/external-callers`, `/external-hosts`) filter on these.
 *
 * External = absolute URL with a public-domain host.
 * Internal  = relative path, localhost / loopback / `.local`,
 *             bare hostname (service-mesh discovery), or any of the
 *             RFC1918 private IPv4 ranges.
 *
 * Mirrors the original implementation in lang-ts so existing TS
 * plugins keep their behavior byte-for-byte after the move; lang-ts
 * re-exports this for back-compat.
 */
export function detectExternalUrl(url: string): { isExternal: boolean; host: string | null } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    // localhost, loopback, and .local are internal
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) {
      return { isExternal: false, host: null };
    }
    // Bare hostnames without a dot are internal service names (e.g., "user-service:3001")
    if (!host.includes('.')) {
      return { isExternal: false, host: null };
    }
    // Private/internal IP ranges (RFC1918, link-local)
    if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.') || host.startsWith('169.254.')) {
      return { isExternal: false, host: null };
    }
    return { isExternal: true, host };
  } catch {
    // Not a valid absolute URL — relative path, always internal
    return { isExternal: false, host: null };
  }
}
