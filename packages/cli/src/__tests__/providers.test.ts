import { describe, expect, it } from 'vitest';
import { parseArgs } from '../cli.js';
import { listProviders, resolveProvider } from '../providers.js';

describe('resolveProvider', () => {
  it('returns undefined for empty name', () => {
    expect(resolveProvider('')).toBeUndefined();
  });

  it('returns the OpenRouter entry for "openrouter"', () => {
    const p = resolveProvider('openrouter');
    expect(p?.llmUrl).toBe('https://openrouter.ai/api/v1');
    expect(p?.apiKeyEnvVar).toBe('OPENROUTER_API_KEY');
  });

  it('is case-insensitive', () => {
    expect(resolveProvider('OpenRouter')?.llmUrl).toBe('https://openrouter.ai/api/v1');
    expect(resolveProvider('OPENAI')?.llmUrl).toBe('https://api.openai.com/v1');
  });

  it('returns the local Ollama entry for "local"', () => {
    expect(resolveProvider('local')?.llmUrl).toBe('http://localhost:11434');
  });

  it('throws on an unknown provider name with a helpful list', () => {
    expect(() => resolveProvider('not-a-thing')).toThrow(/Unknown --provider/);
    expect(() => resolveProvider('not-a-thing')).toThrow(/openrouter, openai, anthropic, local/);
  });

  it('lists every provider for the help / docs', () => {
    const names = listProviders().map((p) => p.name).sort();
    expect(names).toEqual(['anthropic', 'local', 'openai', 'openrouter']);
  });
});

describe('parseArgs: --provider flag', () => {
  it('captures --provider value into args.provider', () => {
    const args = parseArgs(['chat', 'graph.db', '--provider', 'openrouter']);
    expect(args.command).toBe('chat');
    expect(args.provider).toBe('openrouter');
  });

  it('leaves args.provider as empty string when --provider is not passed', () => {
    const args = parseArgs(['chat', 'graph.db', '--model', 'llama3']);
    expect(args.provider).toBe('');
  });

  it('preserves --llm alongside --provider so explicit URL can win', () => {
    const args = parseArgs([
      'chat', 'graph.db',
      '--provider', 'openrouter',
      '--llm', 'https://my-proxy.example.com/v1',
    ]);
    expect(args.provider).toBe('openrouter');
    expect(args.llm).toBe('https://my-proxy.example.com/v1');
  });
});
