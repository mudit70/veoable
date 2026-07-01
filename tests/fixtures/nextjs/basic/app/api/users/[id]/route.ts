// App Router: /api/users/:id
// Dynamic segment with GET and DELETE

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  return Response.json({ id: params.id, name: 'Alice' });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  return new Response(null, { status: 204 });
}
