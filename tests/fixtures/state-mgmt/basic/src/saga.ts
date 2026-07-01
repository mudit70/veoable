// Redux Saga fixture for #256 Phase A.
// Mirrors musiccardapp's saga pattern: a module saga uses takeLatest
// to bind an action type (string literal or imported constant) to a
// generator handler defined in the same file.
import { takeLatest, takeEvery, throttle, call, put } from 'redux-saga/effects';
import { LOGIN_USER_REQUEST, REGISTER_USER_REQUEST } from './action-types.js';

// Handler 1 — receives the dispatched action.
export function* loginModule(data: any) {
  yield call(() => fetch('/api/login', { method: 'POST', body: data.payload }));
  yield put({ type: 'LOGIN_USER_SUCCESS' });
}

// Handler 2 — string-literal action type form.
export function* logoutModule() {
  yield call(() => fetch('/api/logout', { method: 'POST' }));
}

// Handler 3 — for throttle.
export function* searchModule(data: any) {
  yield call(() => fetch(`/api/search?q=${data.payload}`));
}

// Module saga that wires action types to handlers.
export default function* loginSaga() {
  // Imported-constant action type.
  yield takeLatest(LOGIN_USER_REQUEST, loginModule);
  // String-literal action type.
  yield takeEvery('LOGOUT_USER', logoutModule);
  // throttle has a leading delay arg.
  yield throttle(500, 'SEARCH', searchModule);
  // Bare REGISTER reference — same shape, with an inline handler that
  // shouldn't be matched (no FunctionDefinition.id).
  yield takeLatest(REGISTER_USER_REQUEST, function* () {
    yield call(() => fetch('/api/register', { method: 'POST' }));
  });
}
