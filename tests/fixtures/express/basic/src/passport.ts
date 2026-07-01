// #127 — Passport + JWT middleware on Express routes.
import express from 'express';

const app = express();

declare const passport: {
  authenticate: (strategy: string, opts?: object) => (req: any, res: any, next: any) => void;
  initialize: () => (req: any, res: any, next: any) => void;
  session: () => (req: any, res: any, next: any) => void;
};

declare const meHandler: (req: any, res: any) => void;
declare const dashboardHandler: (req: any, res: any) => void;

// Strategy name preserved in middleware-entry name.
app.get('/me', passport.authenticate('jwt'), meHandler);

// Strategy + opts: the opts object is dropped; only the strategy
// (first string arg) is captured in the entry name.
app.get('/dashboard', passport.authenticate('jwt', { session: false }), dashboardHandler);

// Multi-strategy chain — both must surface as separate entries.
app.get('/admin', passport.initialize(), passport.authenticate('jwt'), dashboardHandler);
