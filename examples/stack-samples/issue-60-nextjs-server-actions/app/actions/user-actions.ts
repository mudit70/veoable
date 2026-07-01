'use server'

import { revalidatePath } from 'next/cache';

export async function createUser(formData: FormData) {
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;
  // db.user.create({ name, email })
  revalidatePath('/users');
  return { success: true };
}

export async function deleteUser(userId: string) {
  // db.user.delete({ where: { id: userId } })
  revalidatePath('/users');
  return { deleted: true };
}

export async function updateUser(userId: string, formData: FormData) {
  const name = formData.get('name') as string;
  // db.user.update({ where: { id: userId }, data: { name } })
  revalidatePath('/users');
  return { updated: true };
}
