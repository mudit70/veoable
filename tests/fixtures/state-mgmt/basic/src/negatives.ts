// Negative cases: these should NOT produce ClientSideProcess nodes.

// Generic create() that is NOT Zustand — first arg is not a function.
function create(name: string) { return { name }; }
const user = create('Alice');

// Generic dispatch() with a string argument — not Redux pattern.
function dispatch(event: string) { console.log(event); }
dispatch('click');

// dispatch() with an object literal — not Redux pattern.
function dispatchEvent(event: { type: string }) { console.log(event); }
dispatchEvent({ type: 'click' });

// createAsyncThunk without string first arg.
function createAsyncThunk(fn: () => void) { fn(); }
createAsyncThunk(() => {});

// defineStore without string first arg.
function defineStore(options: Record<string, unknown>) { return options; }
defineStore({ state: () => ({}) });

// Regular autorun (not from mobx — but name matches).
// This one will still match since we can't distinguish by import.
// It's an accepted known gap documented in the review.
