// #191 — client-side `supabase.functions.invoke('<name>', ...)` patterns.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient('https://x.supabase.co', 'anon-key');

// Direct invoke with string literal — should emit ClientSideAPICaller
// for /functions/v1/hello.
export async function callHello() {
  return supabase.functions.invoke('hello');
}

// Invoke with body argument — same shape, just more args.
export async function callBillingWebhook(payload: object) {
  return supabase.functions.invoke('billing-webhook', { body: payload });
}

// No-substitution template form.
export async function callWithBacktick() {
  return supabase.functions.invoke(`hello`);
}

// `this.supabase.functions.invoke(...)` — chain ending at a supabase-like
// receiver. Must be detected.
class Service {
  constructor(public supabase: ReturnType<typeof createClient>) {}
  async run() {
    return this.supabase.functions.invoke('hello');
  }
}

// Negative cases — must NOT emit ClientSideAPICaller.

// Computed function name (not a string literal): conservative skip.
export async function dynamicInvoke(name: string) {
  return supabase.functions.invoke(name);
}

// Non-Supabase receiver named `.functions.invoke()`: must NOT match.
declare const otherSdk: { functions: { invoke: (n: string) => unknown } };
export async function otherInvoke() {
  return otherSdk.functions.invoke('hello');
}

// Plain `.invoke()` without `.functions` prefix: must NOT match.
declare const cmd: { invoke: (n: string) => unknown };
export async function plainInvoke() {
  return cmd.invoke('hello');
}
