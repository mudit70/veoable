import { Router } from './koa-stubs.js';
import { getHealth } from './handlers.js';

const router = Router();

// Cross-file imported handler.
router.get('/health', getHealth);
