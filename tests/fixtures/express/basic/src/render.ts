// Express server-side render fixture (#198 PR3b).
// Tests `res.render('template', ...)` detection inside inline handlers.

import express from 'express';

const app = express();

// Inline arrow handler with res.render — should emit Screen + RENDERS.
app.get('/login', (_req, res) => {
  res.render('auth/signin');
});

// Inline arrow with extra arg (data passed to template) — same shape.
app.get('/dashboard', (_req, res) => {
  res.render('dashboard.njk', { user: 'me' });
});

// Function-expression handler — also inline, also detected.
app.post('/contact', function (_req, res) {
  res.render('contact-success');
});

// Different response param name.
app.get('/about', (_req, response) => {
  response.render('about/index');
});

// Two render calls in branches — both should be emitted.
app.get('/maybe', (req, res) => {
  if (req.query.kind === 'a') {
    res.render('a/page');
  } else {
    res.render('b/page');
  }
});

// Computed template name — should record a confidence-decision and skip.
app.get('/dynamic', (req, res) => {
  const tpl = req.query.tpl as string;
  res.render(tpl);
});

// res.send (not render) — should NOT emit a RENDERS edge.
app.get('/api/users', (_req, res) => {
  res.send({ users: [] });
});

// External handler reference — out of scope (handler is not inline).
function externalHandler(_req: express.Request, res: express.Response): void {
  res.render('external/page');
}
app.get('/external', externalHandler);

// Arrow with expression body (no curly braces) — the concise form.
// Pre-fix the visitor missed this because getDescendantsOfKind doesn't
// include the body itself.
app.get('/concise', (_req, res) => res.render('concise/page'));

// Round 7 — wrapped-send shape: `res.send(nunjucks.render('foo.njk', ...))`.
// The library is imported but renders inside res.send(). The visitor
// must detect the inner `nunjucks.render(...)` call and emit a Screen
// for the inner template.
import nunjucks from 'nunjucks';
declare const pug: { renderFile: (path: string, locals?: object) => string };

app.get('/njk-send', (_req, res) => {
  res.send(nunjucks.render('njk/landing.njk', { user: 'x' }));
});

app.get('/pug-send', (_req, res) => {
  res.send(pug.renderFile('pug/profile.pug', { user: 'y' }));
});
