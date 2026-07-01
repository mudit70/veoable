// App Router: /api/users
// Exports GET and POST handlers

export async function GET() {
  return Response.json([{ id: '1', name: 'Alice' }]);
}

export async function POST(request: Request) {
  const body = await request.json();
  return Response.json({ created: true }, { status: 201 });
}
