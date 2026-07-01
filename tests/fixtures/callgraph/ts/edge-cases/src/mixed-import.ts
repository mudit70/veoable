// Mixed default + named import on one declaration.
import theDefault, { bar } from './target.js';
// Type-only import should still produce an IMPORTS edge.
import type { Foo } from './target.js';
// Side-effect-only import — no symbols, no default.
import './side-effects.js';

export function use() {
  theDefault();
  bar();
  const _f: Foo = { x: 1 };
  return _f;
}
