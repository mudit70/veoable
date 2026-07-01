// Next.js dynamic route — DELETE /api/users/:id
import { PrismaClient } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

const prisma = new PrismaClient();

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await prisma.user.findUnique({
    where: { id: parseInt(params.id) },
    include: { posts: true },
  });
  if (!user) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json(user);
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  await prisma.user.delete({ where: { id: parseInt(params.id) } });
  return new NextResponse(null, { status: 204 });
}
