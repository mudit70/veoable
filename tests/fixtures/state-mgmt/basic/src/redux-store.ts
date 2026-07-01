import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';

// API stub
const api = {
  getUsers: async () => [{ id: '1', name: 'Alice' }],
  deleteUser: async (_id: string) => {},
};

// Redux Toolkit: createAsyncThunk — should be detected as state_observer
export const fetchUsers = createAsyncThunk('users/fetch', async () => {
  const users = await api.getUsers();
  return users;
});

export const removeUser = createAsyncThunk('users/remove', async (id: string) => {
  await api.deleteUser(id);
  return id;
});

// createSlice (NOT a process — it's configuration)
const userSlice = createSlice({
  name: 'users',
  initialState: { users: [] as { id: string; name: string }[] },
});
