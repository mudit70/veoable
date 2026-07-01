// Fixture for #252: chained Supabase queries should emit ONE
// DatabaseInteraction per chain, not one per matching method.

declare const supabase: any;

// Pure read chain: select + single. Should emit ONE 'read' interaction.
export async function getUser(id: string) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .single();
  return data;
}

// Read chain ending in maybeSingle. ONE 'read'.
export async function findUser(email: string) {
  const { data } = await supabase
    .from('users')
    .select('id, name')
    .eq('email', email)
    .maybeSingle();
  return data;
}

// Insert that returns the row via .select().single(). The user-intent
// is a write, so the chain should emit ONE 'write' interaction.
export async function createUser(name: string) {
  const { data } = await supabase
    .from('users')
    .insert({ name })
    .select()
    .single();
  return data;
}

// Update with returning row. ONE 'update'.
export async function renameUser(id: string, name: string) {
  const { data } = await supabase
    .from('users')
    .update({ name })
    .eq('id', id)
    .select()
    .single();
  return data;
}

// Delete that returns the deleted row. ONE 'delete'.
export async function removeUser(id: string) {
  const { data } = await supabase
    .from('users')
    .delete()
    .eq('id', id)
    .select()
    .single();
  return data;
}

// Bare select (no terminal .single()). ONE 'read'.
export async function listUsers() {
  const { data } = await supabase.from('users').select('*');
  return data;
}

// Two SEPARATE chains in the same function on different tables.
// Should emit TWO interactions (one read on users, one write on logs).
export async function readAndLog(id: string) {
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .single();
  await supabase.from('logs').insert({ event: 'read', userId: id });
  return user;
}

// Filter methods (.gt, .in, .order, .range, .neq, .is, .ilike) sit
// in the middle of a chain. They aren't operation methods, but the
// up-walk must traverse them to find the topmost match.
export async function filteredQuery() {
  const { data } = await supabase
    .from('orders')
    .select('id, total')
    .gt('total', 100)
    .in('status', ['paid', 'shipped'])
    .order('created_at', { ascending: false })
    .range(0, 19);
  return data;
}

// Upsert is a write — same precedence as insert. ONE 'write'.
export async function upsertUser(id: string, name: string) {
  const { data } = await supabase
    .from('users')
    .upsert({ id, name }, { onConflict: 'id' })
    .select()
    .single();
  return data;
}

// Non-null mid-chain (`from('t')!.insert(...)`). The walk must peel
// the `!` so dedup still works. ONE 'write'.
export async function insertWithBang(name: string) {
  const { data } = await supabase
    .from('users')!
    .insert({ name })
    .select()
    .single();
  return data;
}

// Parenthesized receiver mid-chain. ONE 'read'.
export async function parenChain(id: string) {
  const { data } = await (supabase.from('users'))
    .select('*')
    .eq('id', id)
    .single();
  return data;
}

// Type assertion (`as Q`) mid-chain. ONE 'read'.
export async function castChain(id: string) {
  const { data } = await (supabase
    .from('users')
    .select('*') as any)
    .eq('id', id)
    .single();
  return data;
}

// Two CHAINS in one function on the SAME table with the SAME operation.
// Per the schema id (callSiteFunctionId, operation, targetTableId),
// these collapse to one canonical DatabaseInteraction node — but the
// dedup is at the schema-id layer, not the visitor layer. The visitor
// emits two distinct nodes (which the canonical store deduplicates
// on insert). This documents the expected behavior.
export async function twoSameTableReads(a: string, b: string) {
  const { data: x } = await supabase.from('users').select('*').eq('id', a).single();
  const { data: y } = await supabase.from('users').select('*').eq('id', b).single();
  return [x, y];
}
