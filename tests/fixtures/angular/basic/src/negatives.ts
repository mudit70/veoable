// Regular class with methods that happen to have similar names but are NOT Angular lifecycle hooks.
// These should NOT produce ClientSideProcess nodes because the class is not an Angular component.

class DataProcessor {
  // Not a lifecycle hook — just a regular method.
  process() {}
  transform() {}
}

// A regular subscribe call outside any class — no enclosing function context.
import { of } from './rxjs-stubs.js';
of(1, 2, 3).subscribe({ next: (v) => console.log(v) });
