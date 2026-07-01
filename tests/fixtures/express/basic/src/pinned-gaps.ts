// Shapes where route detection succeeds (path is literal, receiver is
// `app`) but handler resolution is deliberately left as null because
// it would require machinery outside PR 1's scope.

import express, { type Req, type Res } from 'express';

class UserController {
  handleRequest(_req: Req, res: Res) {
    res.json([]);
  }
}

const app = express();
const ctrl = new UserController();

// The handler expression is a PropertyAccessExpression, not an
// Identifier. Class-method handlers would require class-name-aware
// naming (`${className}.${methodName}`), which is future work.
app.get('/ctrl-method', ctrl.handleRequest);

// `.bind(this)` — the handler expression is a CallExpression, not an
// Identifier. Returns null.
app.get('/ctrl-bound', ctrl.handleRequest.bind(ctrl));

// Zero-argument call — not a route.
// @ts-expect-error — fixture intentionally exercises the 0-arg path.
app.get();

// Single-argument call — subrouter retrieval, not a route.
// @ts-expect-error — fixture intentionally exercises the 1-arg path.
app.get('/single-arg');
