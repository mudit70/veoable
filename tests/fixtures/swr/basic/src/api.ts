export async function fetchOrders(): Promise<unknown[]> {
  const res = await fetch('/api/orders');
  return res.json();
}

export async function fetchOrder(id: string): Promise<unknown> {
  const res = await fetch(`/api/orders/${id}`);
  return res.json();
}
