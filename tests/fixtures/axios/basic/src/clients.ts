import axios from 'axios';

// Exported axios instance used from another file.
export const billingApi = axios.create({ baseURL: '/api/billing' });
