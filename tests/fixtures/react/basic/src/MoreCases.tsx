// Additional fixtures pinning edge-case behavior of the React visitor.
// See visitor.test.ts > "edge cases" for the assertions these anchor.

import {
  useEffect,
  useLayoutEffect,
  useInsertionEffect,
  useState,
} from './react-stubs.js';
import { useEffect as useE } from './react-stubs.js';

// ── Attribute-name matcher table. Each attribute name here is a
// probe for `isEventHandlerAttribute`. Matches: onClick,
// onMouseEnter, onAnimationStart, onX. Rejects: online, onclick
// (all-lowercase), ONCLICK (wrong case), className. `on` alone is
// not a valid JSX attribute name in TS, so we cover <3-char rejection
// via the onX/on distinction (onX matches; 3-char uppercase boundary)
// and rely on unit-style coverage in MatcherTable below.
export function MatcherTable() {
  return (
    <div
      onClick={() => {}}
      onMouseEnter={() => {}}
      onAnimationStart={() => {}}
      onX={() => {}}
      online={true}
      onclick={() => {}}
      ONCLICK={() => {}}
      className="x"
    />
  );
}

// ── useInsertionEffect (React 18+) ──────────────────────────────────
export function InsertionEffectComponent() {
  useInsertionEffect(() => {
    // inject styles
  }, []);
  return <span>x</span>;
}

// ── Fragment wrapper still gets handler detection on inner nodes ────
export function FragmentWrapper() {
  return (
    <>
      <button onClick={() => {}}>ok</button>
      <input onFocus={() => {}} />
    </>
  );
}

// ── Custom component (capitalized) receives an onXxx prop ───────────
// The visitor emits regardless of whether the JSX element is an
// intrinsic or a custom component — that's intentional.
function Child(_props: { onActivate?: () => void }) {
  return <span>child</span>;
}
export function CustomComponentHost() {
  return <Child onActivate={() => {}} />;
}

// ── Nested JSX element: handler attributes to outer component ───────
export function OuterWithNested() {
  return (
    <div>
      <section>
        <button onClick={() => {}}>deep</button>
      </section>
    </div>
  );
}

// ── Nested component definition: inner useEffect attributes to inner
export function Outer() {
  function Inner() {
    useEffect(() => {}, []);
    return <span>inner</span>;
  }
  return <Inner />;
}

// ── Both lifecycle hook AND handler in the same component ──────────
export function MixedComponent() {
  const [, setX] = useState(0);
  useLayoutEffect(() => {}, []);
  return <button onClick={() => setX(1)}>mix</button>;
}

// ── Module-top-level handler / hook: nothing to attribute to ───────
// A top-level JSX expression and a top-level useEffect should NOT
// produce any ClientSideProcess nodes (no enclosing function).
useEffect(() => {
  // top-level
}, []);

export const TOP_LEVEL_JSX = <button onClick={() => {}}>top</button>;

// ── Shorthand (value-less) JSX attribute. React treats this as
// `onClick={true}`. The visitor currently emits a process for it —
// pinned to make any future change an intentional decision.
export function ShorthandAttr() {
  // @ts-expect-error stub IntrinsicElements is permissive but TS may
  // still warn about the shorthand; not important for the visitor.
  return <button onClick>ok</button>;
}

// ── Renamed lifecycle hook import: NOT detected (known gap) ────────
export function RenamedHookComponent() {
  useE(() => {}, []);
  return <span>renamed</span>;
}

// ── Local identifier that shadows `useEffect`: the visitor WILL
// emit a false-positive lifecycle_hook process. Pinned as a known
// limitation of name-based detection.
export function ShadowedHook() {
  const useEffect = (_fn: () => void) => {};
  useEffect(() => {});
  return <span>shadowed</span>;
}
