// #4 — re-export chain. Exercises the type-checker-first path's
// alias-symbol resolution; the syntactic walk would have to chase
// the re-export manually.
export { handleRefresh as handleRefreshReexported } from './handlers.js';
