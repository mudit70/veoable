import { getUser } from './users.js';

export function handler(id: string) {
  return getUser(id);
}
