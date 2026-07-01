import { createServer } from './hapi-stubs.js';

// Non-canonical receiver — should NOT match.
const app = createServer();
app.route({
  method: 'GET',
  path: '/wont-match',
  handler: (_request, h) => h.response('no'),
});

// Unrelated .route() on a different object.
const router = { route: (_path: string) => {} };
router.route('/also-wont-match');
