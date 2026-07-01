import express, { Router, type Req, type Res } from 'express';

const app = express();

// Same-file named handler — should resolve to a FunctionDefinition.
function listUsers(_req: Req, res: Res) {
  res.json([]);
}

// Same-file variable-bound arrow handler.
const getUserById = (req: Req, res: Res) => {
  res.json({ id: req.params.id });
};

// Routes with named handlers.
app.get('/users', listUsers);
app.get('/users/:id', getUserById);

// Route with an inline arrow handler.
app.post('/users', (_req, res) => {
  res.status(201).send();
});

// Route with middleware before the handler.
const requireAuth = (_req: Req, _res: Res, next?: () => void) => next?.();
app.delete('/users/:id', requireAuth, (_req, res) => {
  res.status(204).send();
});

// All Express verbs at least once.
app.put('/users/:id', (_req, res) => res.json({}));
app.patch('/users/:id', (_req, res) => res.json({}));
app.head('/users/:id', (_req, res) => res.send());
app.options('/users/:id', (_req, res) => res.send());
app.all('/catch-all', (_req, res) => res.send());

// Router-level routes. Receiver is named `router`.
const router = Router();
router.get('/profile', (_req, res) => res.json({}));
router.post('/profile', (_req, res) => res.json({}));
app.use('/api', router);
