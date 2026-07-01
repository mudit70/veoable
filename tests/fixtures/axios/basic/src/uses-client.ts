import { billingApi } from './clients.js';

export async function listInvoices() {
  return billingApi.get('/invoices');
}

export async function getInvoiceById(id: string) {
  return billingApi.get(`/invoices/${id}`);
}
