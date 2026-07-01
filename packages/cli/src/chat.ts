import * as readline from 'node:readline';
import type { CanonicalGraphStore } from '@veoable/graph-db';
import { createRestServer, type RestServerOptions } from '@veoable/mcp-server';

/**
 * Built-in chat orchestrator that connects to an OpenAI-compatible
 * LLM API (Ollama, OpenAI, etc.) and handles the tool-calling loop
 * against the Veoable knowledge graph.
 *
 * The flow:
 *  1. Start the tool server internally
 *  2. Send tool schemas to the LLM as function definitions
 *  3. User types a question
 *  4. Send to LLM → if LLM returns tool calls → execute → send results back
 *  5. Print the LLM's final answer
 */

export interface ChatOptions {
  /** LLM API base URL (default: http://localhost:11434 for Ollama). */
  llmUrl: string;
  /** Model name (default: llama3). */
  model: string;
  /** API key for the LLM provider (OpenRouter, OpenAI, etc.). */
  apiKey?: string;
  /** API format: 'ollama' or 'openai'. Auto-detected if not specified. */
  apiFormat?: 'ollama' | 'openai';
  /** Options passed to the internal tool server. */
  serverOpts?: RestServerOptions;
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export async function runChat(
  store: CanonicalGraphStore,
  opts: ChatOptions
): Promise<void> {
  // 1. Build the tool server internally (not listening on a port).
  const rest = createRestServer(store, opts.serverOpts);
  const toolDefs: ToolDef[] = rest.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  // Tool handler map for dispatching tool calls.
  const toolHandlers = new Map(rest.tools.map((t) => [t.name, t.handler]));

  // 2. Build conversation with system prompt.
  const messages: Message[] = [
    {
      role: 'system',
      content:
        'You are an expert code analyst with access to a knowledge graph of a codebase. ' +
        'Use the available tools to answer questions about API endpoints, client-side interactions, ' +
        'database operations, and end-to-end flows.\n\n' +
        'IMPORTANT: Be efficient with tool calls. Call the most relevant tool directly — ' +
        'do NOT chain multiple exploratory calls. For example:\n' +
        '- "how many endpoints?" → call stats (one call)\n' +
        '- "show the stitch report" → call stitch_report (one call)\n' +
        '- "list all endpoints" → call list_server_endpoints (one call)\n' +
        '- "show flows" → call walk_all_flows (one call)\n' +
        '- "what happens when user does X?" → call walk_all_flows with filterByEndpoint\n\n' +
        'Flow tracing tips:\n' +
        '- walk_all_flows returns complete flows including database operations.\n' +
        '- Complete flows have: process → caller → endpoint → handler → database.\n' +
        '- If a flow shows "handler-only" completeness, the database hop was not found ' +
        'via call graph. Use find_edges with edgeType "PERFORMED_BY" to check for ' +
        'database interactions linked to the handler.\n' +
        '- Use get_source_file to read the full handler code when evidence snippets are truncated.\n\n' +
        'Be concise and specific.',
    },
  ];

  // 3. Detect API format (Ollama vs OpenAI).
  // Explicit --api-format takes precedence over auto-detection.
  const isOllama = opts.apiFormat
    ? opts.apiFormat === 'ollama'
    : opts.llmUrl.includes('localhost:11434') || opts.llmUrl.includes('127.0.0.1:11434');
  // Build the chat completions URL. If the user already included /v1, don't double it.
  const baseUrl = opts.llmUrl.replace(/\/+$/, '');
  const chatUrl = isOllama
    ? `${baseUrl}/api/chat`
    : baseUrl.endsWith('/v1')
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;

  console.log(`Connected to ${isOllama ? 'Ollama' : 'OpenAI-compatible API'} at ${opts.llmUrl}`);
  console.log(`Model: ${opts.model}`);
  console.log(`Tools: ${toolDefs.length} available`);
  console.log('Type your question (or "exit" to quit):\n');

  // 4. Interactive loop.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (input === 'exit' || input === 'quit') {
      console.log('Goodbye.');
      rl.close();
      break;
    }
    if (!input) {
      rl.prompt();
      continue;
    }

    messages.push({ role: 'user', content: input });

    try {
      // Tool-calling loop: keep calling the LLM until it produces a
      // final text response (no more tool calls).
      let iterations = 0;
      const MAX_ITERATIONS = 25;

      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const response = await callLlm(chatUrl, opts.model, messages, toolDefs, isOllama, opts.apiKey);

        if (response.tool_calls && response.tool_calls.length > 0) {
          // LLM wants to call tools.
          messages.push({
            role: 'assistant',
            content: response.content,
            tool_calls: response.tool_calls,
          });

          for (const toolCall of response.tool_calls) {
            const handler = toolHandlers.get(toolCall.function.name);
            if (!handler) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` }),
              });
              continue;
            }

            let params: Record<string, unknown>;
            try {
              params = JSON.parse(toolCall.function.arguments);
            } catch {
              params = {};
            }

            try {
              const result = await handler(params);
              const resultStr = JSON.stringify(result, null, 2);
              // Truncate large results to avoid overwhelming the LLM context.
              const truncated = resultStr.length > 8000
                ? resultStr.slice(0, 8000) + '\n... (truncated)'
                : resultStr;
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: truncated,
              });
            } catch (err) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              });
            }
          }

          // Continue the loop — send tool results back to LLM.
          continue;
        }

        // No tool calls — this is the final answer.
        const answer = response.content ?? '(no response)';
        console.log(`\nassistant> ${answer}\n`);
        messages.push({ role: 'assistant', content: answer });
        break;
      }

      if (iterations >= MAX_ITERATIONS) {
        console.log('\n(reached max tool-call iterations)\n');
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    rl.prompt();
  }
}

// ──────────────────────────────────────────────────────────────────────
// LLM API call
// ──────────────────────────────────────────────────────────────────────

interface LlmResponse {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

async function callLlm(
  url: string,
  model: string,
  messages: Message[],
  tools: ToolDef[],
  isOllama: boolean,
  apiKey?: string
): Promise<LlmResponse> {
  const body = isOllama
    ? {
        model,
        messages,
        tools,
        stream: false,
      }
    : {
        model,
        messages,
        tools,
      };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }

  const data = await res.json() as Record<string, unknown>;

  // Ollama format: { message: { role, content, tool_calls } }
  if (isOllama) {
    const msg = data.message as Record<string, unknown> | undefined;
    return {
      content: (msg?.content as string) ?? null,
      tool_calls: msg?.tool_calls as LlmResponse['tool_calls'],
    };
  }

  // OpenAI format: { choices: [{ message: { role, content, tool_calls } }] }
  const choices = data.choices as Array<{ message: Record<string, unknown> }> | undefined;
  const msg = choices?.[0]?.message;
  return {
    content: (msg?.content as string) ?? null,
    tool_calls: msg?.tool_calls as LlmResponse['tool_calls'],
  };
}
