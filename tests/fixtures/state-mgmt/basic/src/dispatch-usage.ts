import { dispatch } from './stubs.js';
import { fetchUsers } from './redux-store.js';

// Generic dispatch — should be detected as event_handler
export function loadData() {
  dispatch(fetchUsers);
}

export function refreshUsers() {
  dispatch(fetchUsers);
}
