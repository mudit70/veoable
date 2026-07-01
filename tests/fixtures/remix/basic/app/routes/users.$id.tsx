// Route: /users/:id
// Dynamic segment with loader only

import { json, type LoaderFunctionArgs } from './remix-stubs.js';

export async function loader({ params }: LoaderFunctionArgs) {
  return json({ id: params.id, name: 'Alice' });
}

export default function UserDetailPage() {
  return null;
}
