// Server Actions file with 'use server' directive
'use server'

export async function createUser(formData: FormData) {
  const name = formData.get('name') as string;
  // Insert into database...
  return { success: true };
}

export async function deleteUser(userId: string) {
  // Delete from database...
  return { deleted: true };
}

// Non-exported function — should NOT be detected
async function validateUser(_name: string) {
  return true;
}
