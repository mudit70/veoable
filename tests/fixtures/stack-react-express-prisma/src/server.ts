import express, { type Req, type Res } from 'express';
import { getUserById, listUsers } from './services/users.js';

const app = express();

/**
 * List all users. The flow walker should stitch from a React caller
 * at `/api/users` to this handler, then follow CALLS_FUNCTION into
 * `listUsers`, then reach the Prisma interaction on User.
 */
export async function listUsersHandler(_req: Req, res: Res) {
  const users = await listUsers();
  res.json(users);
}

/**
 * Get a user by id.
 */
export async function getUserHandler(req: Req, res: Res) {
  const id = Number(req.params.id);
  const user = await getUserById(id);
  if (!user) {
    res.status(404).send();
    return;
  }
  res.json(user);
}

app.get('/api/users', listUsersHandler);
app.get('/api/users/:id', getUserHandler);

app.listen(3000);
