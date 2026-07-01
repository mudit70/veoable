/**
 * `adorable chat --provider <name>` — shortcut that maps a known provider
 * name to its OpenAI-compatible base URL and conventional API-key env
 * variable. Saves users from memorizing URLs like
 * `https://openrouter.ai/api/v1`.
 *
 * Explicit `--llm <url>` always wins over `--provider`, so a user can
 * still point at a custom endpoint while using `--provider` for the
 * API-key fallback.
 */

export interface Provider {
  /** Canonical chat-completions base URL. */
  llmUrl: string;
  /**
   * Env var name to read the API key from when `--api-key` isn't
   * provided. The chat dispatch also falls back to OPENROUTER_API_KEY
   * and OPENAI_API_KEY for backward compatibility.
   */
  apiKeyEnvVar: string;
}

const PROVIDERS: Record<string, Provider> = {
  openrouter: {
    llmUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
  },
  openai: {
    llmUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
  },
  anthropic: {
    // Anthropic's official OpenAI-compatible shim.
    llmUrl: 'https://api.anthropic.com/v1',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  },
  local: {
    // Ollama default; matches the chat command's pre-existing default
    // when no flags are passed.
    llmUrl: 'http://localhost:11434',
    apiKeyEnvVar: 'OLLAMA_API_KEY',
  },
};

/**
 * Look up a provider by name. Returns the entry or undefined if name
 * is empty / unrecognized. Throws on a non-empty name that doesn't
 * match — we want to fail loudly rather than silently fall through to
 * the local-Ollama default when the user clearly intended a remote
 * provider.
 */
export function resolveProvider(name: string): Provider | undefined {
  if (!name) return undefined;
  const provider = PROVIDERS[name.toLowerCase()];
  if (!provider) {
    const supported = Object.keys(PROVIDERS).join(', ');
    throw new Error(
      `Unknown --provider value: ${name}. Supported: ${supported}.`,
    );
  }
  return provider;
}

/** Listing for `--help` text + tests. */
export function listProviders(): Array<{ name: string; llmUrl: string; apiKeyEnvVar: string }> {
  return Object.entries(PROVIDERS).map(([name, p]) => ({ name, ...p }));
}
