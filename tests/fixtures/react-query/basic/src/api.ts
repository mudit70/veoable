export interface Order {
  id: string;
  total: number;
}

export async function createOrder(input: { total: number }): Promise<Order> {
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return res.json();
}

export async function listOrders(): Promise<Order[]> {
  const res = await fetch('/api/orders');
  return res.json();
}
