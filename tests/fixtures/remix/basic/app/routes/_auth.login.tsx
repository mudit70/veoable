// Route: /login (pathless layout prefix _auth is stripped)

import { json, type ActionFunctionArgs } from './remix-stubs.js';

export const action = async ({ request }: ActionFunctionArgs) => {
  return json({ loggedIn: true });
};

export default function LoginPage() {
  return null;
}
