// #264 — fixture: an app-local helper named `useQuery` that is NOT
// imported from @tanstack/react-query / @reduxjs/toolkit. The visitor
// must NOT emit a CALLS_FUNCTION edge for this — it's a local
// function, not a TanStack hook.
function useQuery(_opts: { queryKey: string[]; queryFn: () => unknown }) {
  return { data: null };
}

async function fetchLocal() {
  return [];
}

// Local useQuery call. Looks like TanStack at the syntax level, but
// isn't imported from a known package. The import-source gate (#264)
// must reject it.
export function LocalConsumer() {
  const { data } = useQuery({ queryKey: ['local'], queryFn: fetchLocal });
  return data;
}

// Same shape with takeLatest — local helper, not redux-saga.
function takeLatest(_t: string, _h: unknown) {}
function fetchOtherLocal() {}

export function localSaga() {
  takeLatest('LOCAL_ACTION', fetchOtherLocal);
}
