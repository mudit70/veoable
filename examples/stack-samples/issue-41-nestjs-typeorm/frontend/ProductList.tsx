import React, { useEffect, useState } from 'react';
import axios from 'axios';

interface Product {
  id: number;
  name: string;
  price: number;
}

const API_URL = '/api/products';

export default function ProductList() {
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    axios.get(API_URL).then((res) => setProducts(res.data));
  }, []);

  const handleCreate = async (name: string, price: number) => {
    const res = await axios.post(API_URL, { name, price });
    setProducts([...products, res.data]);
  };

  const handleDelete = async (id: number) => {
    await axios.delete(`${API_URL}/${id}`);
    setProducts(products.filter((p) => p.id !== id));
  };

  return (
    <div>
      <h1>Products</h1>
      <button onClick={() => handleCreate('New Product', 9.99)}>Add</button>
      {products.map((p) => (
        <div key={p.id}>
          <span>{p.name} - ${p.price}</span>
          <button onClick={() => handleDelete(p.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}
