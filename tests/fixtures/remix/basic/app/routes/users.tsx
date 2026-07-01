// Route: /users
// Exports both loader (GET) and action (POST)

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from './remix-stubs.js';

export async function loader({ request }: LoaderFunctionArgs) {
  return json([{ id: '1', name: 'Alice' }]);
}

export async function action({ request }: ActionFunctionArgs) {
  return json({ created: true }, 201);
}

export default function UsersPage() {
  return null;
}
