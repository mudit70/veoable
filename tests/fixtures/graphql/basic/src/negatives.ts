// Shapes that look GraphQL-ish but should NOT produce APIEndpoints.

// 1. A non-resolver object literal with a `Query` key that is NOT a
//    GraphQL resolver: a redux-style state shape. The single-type +
//    no-"resolver"-name guard at visitor.ts:52-62 must reject.
export const reduxStore = {
  Query: { fetching: false, results: [] },
};

// 2. An ad-hoc object whose property happens to be named `Query` and
//    whose enclosing identifier is unrelated. Same shape as the redux
//    case; pinned separately for clarity.
function makeQueryDescriptor() {
  return {
    Query: { kind: 'select', table: 'users' },
  };
}
makeQueryDescriptor();

// 3. A `Query` property declared inside a module-level expression with
//    no enclosing variable name at all (e.g. an export expression).
//    The heuristic's grandparent check returns nothing useful and the
//    property is skipped.
export default {
  Query: { meta: 'no-resolver-name-here' },
};
