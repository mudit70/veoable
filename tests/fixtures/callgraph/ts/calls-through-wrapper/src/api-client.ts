import { baseGet } from './base-client.js';

export const apiClient = {
  get(url: string) {
    return baseGet(url);
  },
};

// Wrapper function that delegates to the api-client
export function getOrders() {
  return apiClient.get('/orders');
}
