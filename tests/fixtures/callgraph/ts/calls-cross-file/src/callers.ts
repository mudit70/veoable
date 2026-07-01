// Exercise direct cross-file resolution against three different
// callee shapes (variable-bound arrow, default-exported function,
// namespace-imported function), plus an external (console.log) call
// that must NOT produce an edge.
import { greet } from './arrows.js';
import defaultHelper from './default-fn.js';
import * as ns from './namespace-target.js';

export function callsArrow(): string {
  return greet('world');
}

export function callsDefault(): number {
  return defaultHelper();
}

export function callsNamespace(): number {
  return ns.nsFn();
}

export function callsExternal(x: unknown): void {
  // External callee — should be silently skipped (no edge, no decision).
  console.log(x);
}
