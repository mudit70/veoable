// Next.js API route with server-side Supabase — both API route and DB patterns
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// GET /api/todos — server-side Supabase query
export async function GET() {
  const { data, error } = await supabase
    .from('todos')
    .select('*, profiles(name)')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/todos — server-side insert with RLS bypass
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { data, error } = await supabase
    .from('todos')
    .insert({ title: body.title, user_id: body.userId })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 201 });
}
