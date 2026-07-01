import type { Req, Res } from 'express';

export function importedHandler(_req: Req, res: Res) {
  res.json({ from: 'handlers.ts' });
}
