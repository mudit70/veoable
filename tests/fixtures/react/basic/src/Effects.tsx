import { useEffect, useLayoutEffect, useState, useMemo, useCallback } from './react-stubs.js';

export function Effects({ userId }: { userId: number }) {
  const [data, setData] = useState<unknown>(null);

  // lifecycle_hook
  useEffect(() => {
    setData({ id: userId });
  }, [userId]);

  // lifecycle_hook (layout variant)
  useLayoutEffect(() => {
    // measure DOM
  });

  // Non-lifecycle hooks should NOT emit ClientSideProcess nodes.
  const doubled = useMemo(() => userId * 2, [userId]);
  const cb = useCallback(() => userId, [userId]);

  return (
    <div>
      <span>{doubled}</span>
      <button onClick={cb}>click</button>
    </div>
  );
}
