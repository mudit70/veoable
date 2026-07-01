// Named function declaration export
export function namedFnExport() {
  return 1;
}

// Default function declaration export
export default function defaultFnExport() {
  return 2;
}

// Named arrow function export
export const arrowExport = () => 3;

// Named function expression export
export const fnExpressionExport = function inner() {
  return 4;
};

// Non-exported function (should appear with isExported: false)
function privateHelper() {
  return 5;
}
