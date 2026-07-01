// #4 — JSX `onClick={importedFn}` cross-file resolution. The
// visitor should emit TRIGGERS edges to the imported function's
// FunctionDefinition id (computed using the target file's
// repository-relative path).
import { handleRefresh, handleSubmit } from './handlers.js';
import handleDefault from './handlers.js';
import { handleRefreshReexported } from './handlers-reexport.js';

export function CrossFileHandlers() {
  return (
    <div>
      <button onClick={handleRefresh}>refresh</button>
      <form onSubmit={handleSubmit}>
        <button type="submit">submit</button>
      </form>
      <button onClick={handleDefault}>default</button>
      <button onClick={handleRefreshReexported}>reexported</button>
    </div>
  );
}
