// #264 — fixture: renamed import of takeLatest. The visitor should
// still detect this as a saga because the symbol resolves to the
// real takeLatest export from redux-saga/effects.
import { takeLatest as tl, call as c } from 'redux-saga/effects';

function* loginHandler(_data: any) {
  yield c(() => {});
}

export default function* renamedSaga() {
  yield tl('LOGIN_RENAMED', loginHandler);
}
