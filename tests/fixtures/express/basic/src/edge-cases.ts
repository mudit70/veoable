// Edge-case shapes that pin current behavior. These are NOT bugs —
// each case is a deliberate scope decision for PR 1 of #15.

import express, { type Req, type Res } from 'express';

const app = express();

// Path with query string suffix. Express doesn't parse query strings
// at route declaration time, but it's legal to write one — the
// visitor must emit it verbatim without choking.
app.get('/users?sort=name', (_req: Req, res: Res) => res.send());

// Path with multiple parameter segments.
app.get('/users/:id/posts/:postId', (_req: Req, res: Res) => res.json({}));

// Empty-string path — rare, but legal.
app.get('', (_req: Req, res: Res) => res.send());

// Same (method, path) declared twice in the same file. Both
// declarations emit APIEndpoint nodes with the same content-addressed
// id, and the store de-duplicates them on commit.
app.get('/dup', (_req: Req, res: Res) => res.send());
app.get('/dup', (_req: Req, res: Res) => res.send());

// `app.route('/chained').get(...).post(...)` — chained-declaration
// form. NOT detected in PR 1 — this is a documented gap (see
// README's "Out of scope"). The test pins zero endpoints for this
// route pattern.
app
  .route('/chained')
  .get((_req: Req, res: Res) => res.send())
  .post((_req: Req, res: Res) => res.send());
