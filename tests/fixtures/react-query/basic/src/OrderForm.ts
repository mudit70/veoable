import { useMutation, useQuery } from '@tanstack/react-query';
import { createOrder, listOrders } from './api';

export function OrderForm() {
  // Shape 1: bare identifier mutationFn.
  const create = useMutation({ mutationFn: createOrder });

  // Shape 2: inline arrow mutationFn.
  const inline = useMutation({
    mutationFn: async (input: { total: number }) => {
      return createOrder(input);
    },
  });

  // Shape 3: useQuery with bare queryFn.
  const list = useQuery({ queryKey: ['orders'], queryFn: listOrders });

  // Shape 4: deprecated v3 positional form.
  const positional = useMutation(createOrder);

  // Shape 5: shorthand-property mutationFn.
  const mutationFn = createOrder;
  const shorthand = useMutation({ mutationFn });

  return { create, inline, list, positional, shorthand };
}
