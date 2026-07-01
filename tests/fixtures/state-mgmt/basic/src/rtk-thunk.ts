// Fixture for #256 Phase B — RTK createAsyncThunk dispatch resolution.
import { createAsyncThunk } from '@reduxjs/toolkit'; declare const dispatch: (a: unknown) => void;

// Named payload creator — resolvable to a FunctionDefinition.id.
async function fetchUserPayload(id: string) {
  const res = await fetch(`/api/users/${id}`);
  return res.json();
}

// Variable-bound arrow payload creator.
const removeUserPayload = async (id: string) => {
  await fetch(`/api/users/${id}`, { method: 'DELETE' });
  return id;
};

// Thunk creators.
export const fetchUser = createAsyncThunk('users/fetch', fetchUserPayload);
export const removeUser = createAsyncThunk('users/remove', removeUserPayload);

// Inline arrow — no resolvable id, edge skipped.
export const inlineThunk = createAsyncThunk('users/inline', async () => {
  return await fetch('/api/inline');
});

// Plain (non-thunk) action creator — should NOT emit a thunk edge.
function nonThunkAction(id: string) {
  return { type: 'PLAIN_ACTION', payload: id };
}

// Dispatch sites.
export function dispatchScenarios(id: string) {
  // Form 1: dispatch(thunk(args))
  dispatch(fetchUser(id));
  // Form 2: dispatch(thunk()) with no args
  dispatch(fetchUser());
  // Form 3: dispatch(thunk) — pass the creator itself
  dispatch(removeUser);
  // Form 4: inline thunk — no edge expected (inline arrow)
  dispatch(inlineThunk(id));
  // Form 5: plain action creator — no thunk edge (init isn't createAsyncThunk)
  dispatch(nonThunkAction(id));
}
