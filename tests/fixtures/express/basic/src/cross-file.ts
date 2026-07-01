// Handlers imported from another file — exercises cross-file
// resolution via the shared resolve-handler util.
import express, { type Req, type Res } from 'express';
import { importedHandler } from './handlers.js';

const app = express();

app.get('/imported', importedHandler);

// Inline handler with a body that could reference anything.
app.post('/inline', (_req: Req, res: Res) => res.json({}));
