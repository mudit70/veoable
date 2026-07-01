// Route: / (index route)

import { json } from './remix-stubs.js';

export function loader() {
  return json({ page: 'home' });
}

export default function IndexPage() {
  return null;
}
