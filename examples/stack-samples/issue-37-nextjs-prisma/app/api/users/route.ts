// Next.js App Router API route — patterns a framework-nextjs visitor must detect
import { PrismaClient } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

const prisma = new PrismaClient();

// GET /api/users — list all users
export async function GET() {
  const users = await prisma.user.findMany({
    include: { posts: true },
  });
  return NextResponse.json(users);
}

// POST /api/users — create a user
export async function POST(request: NextRequest) {
  const body = await request.json();
  const user = await prisma.user.create({
    data: { name: body.name, email: body.email },
  });
  return NextResponse.json(user, { status: 201 });
}
