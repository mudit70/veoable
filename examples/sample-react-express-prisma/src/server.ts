import express, { type Request, type Response } from 'express';
import { listUsers, getUserById, createUser, updateUser, deleteUser } from './services/users.js';
import { listPostsByUser, createPost, deletePost } from './services/posts.js';

const app = express();
app.use(express.json());

// ── User routes ────────────────────────────────────────────────────

export async function listUsersHandler(_req: Request, res: Response) {
  const users = await listUsers();
  res.json(users);
}

export async function getUserHandler(req: Request, res: Response) {
  const id = Number(req.params.id);
  const user = await getUserById(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
}

export async function createUserHandler(req: Request, res: Response) {
  const { email, name } = req.body as { email: string; name?: string };
  const user = await createUser(email, name ?? null);
  res.status(201).json(user);
}

export async function updateUserHandler(req: Request, res: Response) {
  const id = Number(req.params.id);
  const data = req.body as { email?: string; name?: string | null };
  const user = await updateUser(id, data);
  res.json(user);
}

export async function deleteUserHandler(req: Request, res: Response) {
  const id = Number(req.params.id);
  await deleteUser(id);
  res.status(204).send();
}

app.get('/api/users', listUsersHandler);
app.get('/api/users/:id', getUserHandler);
app.post('/api/users', createUserHandler);
app.put('/api/users/:id', updateUserHandler);
app.delete('/api/users/:id', deleteUserHandler);

// ── Post routes ────────────────────────────────────────────────────

export async function listPostsHandler(req: Request, res: Response) {
  const authorId = Number(req.params.userId);
  const posts = await listPostsByUser(authorId);
  res.json(posts);
}

export async function createPostHandler(req: Request, res: Response) {
  const authorId = Number(req.params.userId);
  const { title, content } = req.body as { title: string; content?: string };
  const post = await createPost(authorId, title, content ?? null);
  res.status(201).json(post);
}

export async function deletePostHandler(req: Request, res: Response) {
  const id = Number(req.params.id);
  await deletePost(id);
  res.status(204).send();
}

app.get('/api/users/:userId/posts', listPostsHandler);
app.post('/api/users/:userId/posts', createPostHandler);
app.delete('/api/users/:userId/posts/:id', deletePostHandler);

app.listen(3000);
