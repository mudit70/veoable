// Route: /api/health
// API route with loader only (no default export needed for resource routes)

import { json } from './remix-stubs.js';

export function loader() {
  return json({ status: 'ok' });
}
