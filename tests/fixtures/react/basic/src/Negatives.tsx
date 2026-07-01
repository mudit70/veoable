// Shapes that look process-ish but should NOT produce ClientSideProcess nodes.

export function Negatives() {
  return (
    <div
      className="not-a-handler"
      style={{ color: 'red' }}
      // `online` starts with "on" but the third char is lowercase, not
      // an event handler.
      {...{ online: true }}
    >
      child
    </div>
  );
}

// Calling `useEffect` spelled differently — not a React lifecycle hook.
function useEffectLike(_fn: () => void) {
  return 1;
}

export function Component() {
  // Not useEffect / useLayoutEffect.
  useEffectLike(() => {});
  return <span>ok</span>;
}
