// Receiver bindings whose name is anything but `app` / `router`.
// Every one of these is created by `express()` or `Router()`, so the
// AST-based resolver MUST recognize them and emit endpoints. Closes
// the gap from #180 where a regex on receiver-name silently dropped
// every route in projects that name their app `expressApp` (or
// anything else).

import express, { Router } from 'express';

// The exact pattern from the test-code-comprehension repo that
// originally surfaced #180.
const expressApp = express();
expressApp.get('/renamed-app-get', (_req, res) => res.send());
expressApp.post('/renamed-app-post', (_req, res) => res.json({}));

// Generic English noun — `server`, `api`, `myApp` — all real-world
// names for Express instances.
const server = express();
server.get('/server-get', (_req, res) => res.send());

const api = express();
api.post('/api-post', (_req, res) => res.send());

const myApp = express();
myApp.put('/myApp-put', (_req, res) => res.send());

const _app = express();
_app.delete('/underscore-app-delete', (_req, res) => res.send());

const app2 = express();
app2.patch('/app2-patch', (_req, res) => res.send());

// Renamed Router — `usersRouter` is the standard convention for
// per-resource routers.
const usersRouter = Router();
usersRouter.get('/users-router-get', (_req, res) => res.send());
usersRouter.post('/users-router-post', (_req, res) => res.send());

// Default-import called without the canonical `express` binding name.
const makeApp = express;
const renamed = makeApp();
renamed.get('/renamed-via-alias', (_req, res) => res.send());

// Class field initialized in the field declaration.
class FieldInitServer {
  app = express();
  registerRoutes() {
    this.app.get('/class-field-init', (_req, res) => res.send());
  }
}
new FieldInitServer().registerRoutes();

// Class field assigned in the constructor.
class CtorAssignServer {
  private routes: ReturnType<typeof express>;
  constructor() {
    this.routes = express();
  }
  registerRoutes() {
    this.routes.get('/class-ctor-assign', (_req, res) => res.send());
  }
}
new CtorAssignServer().registerRoutes();

// Reassigned binding — `let` then assigned later.
let lateApp: ReturnType<typeof express>;
lateApp = express();
lateApp.get('/let-reassigned', (_req, res) => res.send());

// `express.Router()` rather than the named `Router` import.
const namespacedRouter = express.Router();
namespacedRouter.get('/namespaced-router-get', (_req, res) => res.send());

// Method-chained receiver: `.use(mw)` returns the same routable, so
// the `.get(...)` call is still a route declaration on the same app.
const chainedApp = express();
chainedApp.use(() => {}).get('/chained-after-use', (_req, res) => res.send());
