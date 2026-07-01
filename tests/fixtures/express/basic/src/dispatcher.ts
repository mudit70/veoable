// #194 — custom request-name dispatcher patterns. Each variant must
// be detected (Signal 1 + Signal 2). The visitor should emit one
// APIEndpoint per object-literal key.
import express from 'express';

const app = express();

// ──────────────────────────────────────────────────────────────────────
// Positive cases — must be expanded.
// ──────────────────────────────────────────────────────────────────────

// Direct: function dispatch(handlers) { return (req, res) => handlers[req.query.r](req, res); }
function handleAPIRequest(handlers: Record<string, (req: any, res: any) => void>) {
  return (req: any, res: any) => {
    const r = req.query.r;
    if (!r || typeof r !== 'string') return res.status(400).end();
    const fn = handlers[r];
    if (!fn) return res.status(400).end();
    return fn(req, res);
  };
}

declare const initializeGetComputers: () => (req: any, res: any) => void;
declare const initializeCreateComputer: () => (req: any, res: any) => void;
declare const initializeDeleteComputer: () => (req: any, res: any) => void;

app.post('/api/jade', handleAPIRequest({
  GetComputers: initializeGetComputers(),
  CreateComputer: initializeCreateComputer(),
  DeleteComputer: initializeDeleteComputer(),
}));

// Renamed param: `function dispatch(handlerMap)`.
function dispatchHandlerMap(handlerMap: Record<string, (req: any, res: any) => void>) {
  return (req: any, res: any) => handlerMap[req.query.r](req, res);
}

declare const handlerOne: (req: any, res: any) => void;
declare const handlerTwo: (req: any, res: any) => void;

app.post('/api/v2', dispatchHandlerMap({
  Foo: handlerOne,
  Bar: handlerTwo,
}));

// Aliased local: `const h = handlers; h[req.query.r](req, res);`
function dispatchAliased(handlers: Record<string, (req: any, res: any) => void>) {
  return (req: any, res: any) => {
    const h = handlers;
    return h[req.query.r](req, res);
  };
}

app.post('/api/aliased', dispatchAliased({
  Action1: handlerOne,
  Action2: handlerTwo,
}));

// Body-source: `req.body.action` instead of `req.query.r`.
function dispatchByBody(handlers: Record<string, (req: any, res: any) => void>) {
  return (req: any, res: any) => handlers[req.body.action](req, res);
}

app.post('/api/by-body', dispatchByBody({
  Save: handlerOne,
  Cancel: handlerTwo,
}));

// ──────────────────────────────────────────────────────────────────────
// Negative cases — must NOT be expanded.
// ──────────────────────────────────────────────────────────────────────

// validate({body: schema}) — Joi/Zod-style validator middleware.
declare function validate(opts: object): (req: any, res: any, next: any) => void;
declare const userSchema: object;
declare const createUser: (req: any, res: any) => void;

app.post('/users', validate({ body: userSchema }), createUser);

// auth({required: true, roles: ['admin']}) — auth middleware factory.
declare function auth(opts: object): (req: any, res: any, next: any) => void;
declare const adminHandler: (req: any, res: any) => void;

app.post('/admin', auth({ required: true, roles: ['admin'] }), adminHandler);

// graphqlHTTP({schema, rootValue}) — single handler, no dispatch.
declare function graphqlHTTP(opts: object): (req: any, res: any) => void;
declare const gqlSchema: object;

app.use('/graphql', graphqlHTTP({ schema: gqlSchema, rootValue: {} }));

// multer({...}).single('file') — upload middleware chain.
declare function multer(opts: object): { single: (n: string) => (req: any, res: any, next: any) => void };
declare const fileHandler: (req: any, res: any) => void;

app.post('/upload', multer({ dest: '/tmp', limits: {} }).single('file'), fileHandler);

// helmet({...}) — security middleware.
declare function helmet(opts: object): (req: any, res: any, next: any) => void;
app.use('/secured', helmet({ contentSecurityPolicy: true }));

// cors({...}) — CORS middleware.
declare function cors(opts: object): (req: any, res: any, next: any) => void;
app.use('/api/with-cors', cors({ origin: '*' }));
