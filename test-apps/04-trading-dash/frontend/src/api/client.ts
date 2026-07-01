export interface Order {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  priceCents: number;
  status: 'pending' | 'filled' | 'cancelled';
  placedAt: string;
}

export interface NewOrderInput {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  priceCents: number;
}

export interface PortfolioPosition {
  symbol: string;
  quantity: number;
  avgCostCents: number;
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status}`);
  return res.json();
}

export async function listOrders(symbol: string): Promise<Order[]> {
  return jfetch(`/api/orders?symbol=${encodeURIComponent(symbol)}`);
}

export async function placeOrder(input: NewOrderInput): Promise<Order> {
  return jfetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function getPortfolio(): Promise<PortfolioPosition[]> {
  return jfetch('/api/portfolio');
}

export async function cancelOrder(id: string): Promise<void> {
  await fetch(`/api/orders/${id}`, { method: 'DELETE' });
}
