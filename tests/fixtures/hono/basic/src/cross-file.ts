import { Hono } from './hono-stubs.js';
import { getHealth } from './handlers.js';

const app = Hono();

app.get('/health', getHealth);
