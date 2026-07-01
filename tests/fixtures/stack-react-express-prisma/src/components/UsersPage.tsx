import { useEffect, useState } from '../stubs/react.js';

/**
 * The end-to-end demo target: a React component with two distinct
 * client processes that each reach the database by different paths.
 *
 *   - A `useEffect` lifecycle hook on mount fetches `/api/users` (the
 *     list endpoint)
 *   - An `onClick` handler on the "load user 42" button fetches
 *     `/api/users/42` (the by-id endpoint; template-literal URL)
 *
 * Both should be walkable end-to-end by the flow walker after the
 * stitcher has emitted RESOLVES_TO_ENDPOINT edges.
 */
export function UsersPage() {
  const [users, setUsers] = useState<unknown[]>([]);
  const [detail, setDetail] = useState<unknown>(null);

  useEffect(() => {
    fetch('/api/users').then((r) => r.json()).then(setUsers);
  }, []);

  // Inline arrow handler — this keeps the fetch in UsersPage's
  // enclosingFunction scope, which is what the walker's BFS needs to
  // find it. A named handler (`const handleLoadUser = () => ...`
  // referenced via `onClick={handleLoadUser}`) is a real known gap:
  // JSX attribute references do NOT produce `CALLS_FUNCTION` edges,
  // so the walker can't reach the named handler's body from the
  // component. That gap is pinned by a test in the stack suite and
  // flagged for a future framework-react enhancement.
  return (
    <div>
      <button
        onClick={() => {
          const id = 42;
          fetch(`/api/users/${id}`).then((r) => r.json()).then(setDetail);
        }}
      >
        Load user 42
      </button>
      <pre>{JSON.stringify(users)}</pre>
      <pre>{JSON.stringify(detail)}</pre>
    </div>
  );
}
