import React, { useEffect, useState } from 'react';

interface Order {
  id: number;
  customerName: string;
  total: number;
  status: string;
}

export default function OrderList() {
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    fetch('/api/orders')
      .then((res) => res.json())
      .then(setOrders);
  }, []);

  const handleCreate = async () => {
    await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: 'John', items: [{ productId: 1, quantity: 2 }] }),
    });
  };

  const handleCancel = async (id: number) => {
    await fetch(`/api/orders/${id}/cancel`, { method: 'POST' });
    setOrders(orders.map((o) => (o.id === id ? { ...o, status: 'cancelled' } : o)));
  };

  return (
    <div>
      <button onClick={handleCreate}>New Order</button>
      {orders.map((o) => (
        <div key={o.id}>
          <span>{o.customerName} - ${o.total} [{o.status}]</span>
          <button onClick={() => handleCancel(o.id)}>Cancel</button>
        </div>
      ))}
    </div>
  );
}
