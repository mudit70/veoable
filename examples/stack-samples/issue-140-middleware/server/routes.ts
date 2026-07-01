import express from 'express';

const app = express();

function authMiddleware(req: any, res: any, next: any) {
  if (!req.headers.authorization) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function validateBody(req: any, res: any, next: any) {
  if (!req.body) {
    return res.status(400).json({ error: 'body required' });
  }
  next();
}

function logRequest(req: any, res: any, next: any) {
  console.log(`${req.method} ${req.url}`);
  next();
}

// Route with middleware chain
app.get('/api/users', authMiddleware, (req, res) => {
  res.json([{ id: 1, name: 'Alice' }]);
});

app.post('/api/users', authMiddleware, validateBody, (req, res) => {
  res.status(201).json({ id: 2, name: req.body.name });
});

app.delete('/api/users/:id', authMiddleware, logRequest, (req, res) => {
  res.status(204).send();
});

// Route without middleware
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});
