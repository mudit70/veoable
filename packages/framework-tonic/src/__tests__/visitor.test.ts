import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { idFor, type APIEndpoint, type SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { TonicPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/tonic/basic');

async function extract(file: string): Promise<NodeBatch> {
  const tonic = new TonicPlugin();
  const rust = new RustLanguagePlugin();
  rust.registerVisitor(tonic.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-tonic visitor (#439)', () => {
  it('emits one APIEndpoint per async method in a tonic-async-trait impl', async () => {
    const batch = await extract('src/main.rs');
    const patterns = endpoints(batch).map((e) => e.routePattern).sort();
    // MyGreeter (3) + AnotherGreeter (1) + ScopedGreeter (1) +
    // EchoServer (1) + BareGreeter (1, via bare `#[async_trait]`
    // after `use tonic::async_trait;`) + NonSendGreeter (1, via
    // `#[async_trait(?Send)]`) = 8. The two duplicate
    // `grpc:Greeter/say_hello` entries come from MyGreeter +
    // AnotherGreeter sharing the trait name with different impls.
    expect(patterns).toEqual([
      'grpc:BareTrait/bare_method',
      'grpc:Echo/echo',
      'grpc:Greeter/list_users',
      'grpc:Greeter/say_goodbye',
      'grpc:Greeter/say_hello',
      'grpc:Greeter/say_hello',
      'grpc:NonSendTrait/non_send_method',
      'grpc:Whisper/whisper',
    ]);
  });

  it('marks every endpoint with httpMethod=GRPC + framework=tonic', async () => {
    const batch = await extract('src/main.rs');
    for (const e of endpoints(batch)) {
      expect(e.httpMethod).toBe('GRPC');
      expect(e.framework).toBe('tonic');
    }
  });

  it('strips scoped path prefixes from the trait name (greeter_server::Greeter → Greeter)', async () => {
    const batch = await extract('src/main.rs');
    const greeterPatterns = endpoints(batch).filter((e) =>
      e.routePattern.startsWith('grpc:Greeter/'),
    );
    // 3 from MyGreeter + 1 from AnotherGreeter = 4.
    expect(greeterPatterns.length).toBe(4);
  });

  it('accepts bare `#[async_trait]` when `use tonic::async_trait;` is in scope', async () => {
    const batch = await extract('src/main.rs');
    const bare = endpoints(batch).find((e) => e.routePattern === 'grpc:BareTrait/bare_method');
    expect(bare).toBeTruthy();
    expect(bare!.framework).toBe('tonic');
  });

  it('accepts the `#[async_trait(?Send)]` arg form', async () => {
    const batch = await extract('src/main.rs');
    const ep = endpoints(batch).find((e) => e.routePattern === 'grpc:NonSendTrait/non_send_method');
    expect(ep).toBeTruthy();
  });

  it('rejects lookalike attributes (`#[async_trait_helper]`) via the \\b anchor', async () => {
    const batch = await extract('src/main.rs');
    const eps = endpoints(batch).map((e) => e.routePattern);
    expect(eps).not.toContain('grpc:LookalikeTrait/lookalike_method');
  });

  it('rejects bare `#[async_trait]` when imported from a non-tonic crate', async () => {
    // no_tonic.rs uses `use async_trait::async_trait;` (the
    // standalone crate, NOT tonic). Visitor must produce no
    // endpoints.
    const batch = await extract('src/no_tonic.rs');
    expect(endpoints(batch)).toEqual([]);
  });

  it('handles generic impl types (`EchoServer<T>` → `EchoServer`)', async () => {
    const batch = await extract('src/main.rs');
    const echo = endpoints(batch).find((e) => e.routePattern === 'grpc:Echo/echo');
    expect(echo).toBeTruthy();
    // The handlerFunctionId is the content-addressed id that
    // lang-rust registers methods under: `<ImplType>.<methodName>`.
    // For `impl Echo for EchoServer<T>` the impl type is the bare
    // identifier `EchoServer` (generic stripped). Compute the
    // expected id directly via idFor to compare.
    const sf = batch.nodes.find((n) => n.nodeType === 'SourceFile')!;
    const echoFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'EchoServer.echo',
    );
    expect(echoFn).toBeTruthy();
    expect(echo!.handlerFunctionId).toBe(echoFn!.id);
    // Bonus sanity: the id matches what idFor would compute given
    // the SourceFile + name + line we expect.
    const expected = idFor.functionDefinition({
      sourceFileId: sf.id,
      name: 'EchoServer.echo',
      sourceLine: echoFn!.sourceLine,
    });
    expect(echo!.handlerFunctionId).toBe(expected);
  });

  it('does NOT emit endpoints from a plain `impl Struct` block (no tonic attr)', async () => {
    const batch = await extract('src/main.rs');
    // `impl MyGreeter { pub fn helper() ... pub async fn definitely_not... }`
    // must not register; its routePattern would be `grpc:MyGreeter/...`
    // which we DO NOT expect to see.
    const eps = endpoints(batch).map((e) => e.routePattern);
    expect(eps.some((p) => p.startsWith('grpc:MyGreeter/'))).toBe(false);
    expect(eps.some((p) => p.includes('helper'))).toBe(false);
    expect(eps.some((p) => p.includes('definitely_not_a_grpc_method'))).toBe(false);
  });

  it('does NOT emit endpoints for synchronous fns inside a tonic impl block', async () => {
    const batch = await extract('src/main.rs');
    // `impl SyncTrait for MyGreeter { fn never_emitted ... }`.
    const eps = endpoints(batch).map((e) => e.routePattern);
    expect(eps).not.toContain('grpc:SyncTrait/never_emitted');
  });

  it('ignores `#[derive(...)]` attributes that happen to precede an impl', async () => {
    const batch = await extract('src/main.rs');
    // UnrelatedStruct has a `#[derive(Default)]` attribute but the impl
    // below it has NO tonic::async_trait. Must not register.
    const eps = endpoints(batch).map((e) => e.routePattern);
    expect(eps).not.toContain('grpc:UnrelatedStruct/unrelated_method');
  });

  it('handler-id alignment for scoped impl types (`impl T for path::Struct` — regression for #445 review)', async () => {
    const batch = await extract('src/main.rs');
    // lang-rust registers the method under its FULL impl-type
    // path (`inner_mod::ScopedGreeter.whisper`). If the visitor
    // strips the scoped prefix on its side, the endpoint's
    // handlerFunctionId never resolves to the function node.
    const fn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'inner_mod::ScopedGreeter.whisper',
    );
    expect(fn, 'lang-rust must register the scoped impl method under its full path').toBeTruthy();

    const whisper = endpoints(batch).find((e) => e.routePattern === 'grpc:Whisper/whisper');
    expect(whisper).toBeTruthy();
    expect(whisper!.handlerFunctionId).toBe(fn!.id);
  });

  it('attaches SourceEvidence + a handlerFunctionId that resolves to MyGreeter.say_hello', async () => {
    const batch = await extract('src/main.rs');
    // There are TWO say_hello endpoints (MyGreeter + AnotherGreeter).
    // Pick the one with MyGreeter's evidence by checking the
    // corresponding FunctionDefinition id ties back to MyGreeter.
    const myGreeterSayHello = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'MyGreeter.say_hello',
    );
    expect(myGreeterSayHello).toBeTruthy();
    const ep = endpoints(batch).find((e) => e.handlerFunctionId === myGreeterSayHello!.id);
    expect(ep).toBeTruthy();
    expect(ep!.routePattern).toBe('grpc:Greeter/say_hello');
    expect(ep!.evidence?.filePath).toContain('main.rs');
    expect(ep!.evidence?.lineStart).toBeGreaterThan(0);
  });
});
