// Pages Router API route: /api/legacy

interface Req { method: string; body: unknown; }
interface Res { status: (code: number) => Res; json: (body: unknown) => void; }

export default function handler(req: Req, res: Res) {
  if (req.method === 'GET') {
    res.json({ legacy: true });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
