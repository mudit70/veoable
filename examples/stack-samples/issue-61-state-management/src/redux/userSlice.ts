import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

export const fetchUsers = createAsyncThunk('users/fetch', async () => {
  const res = await fetch('/api/users');
  return res.json();
});

export const deleteUser = createAsyncThunk('users/delete', async (id: string) => {
  await fetch(`/api/users/${id}`, { method: 'DELETE' });
  return id;
});

const userSlice = createSlice({
  name: 'users',
  initialState: { users: [] as any[], loading: false },
  reducers: {
    clearUsers: (state) => { state.users = []; },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchUsers.pending, (state) => { state.loading = true; })
      .addCase(fetchUsers.fulfilled, (state, action) => { state.users = action.payload; state.loading = false; })
      .addCase(deleteUser.fulfilled, (state, action) => { state.users = state.users.filter(u => u.id !== action.payload); });
  },
});

export const { clearUsers } = userSlice.actions;
export default userSlice.reducer;
