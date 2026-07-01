// Top-level function declaration
function topLevelFn(a: number, b: string): boolean {
  return a > 0 && b.length > 0;
}

// Async function
async function fetchSomething(id: string): Promise<unknown> {
  return { id };
}

// Arrow function bound to const
const arrow = (x: number) => x * 2;

// Function expression bound to const
const expr = function (y: number) {
  return y + 1;
};

// Class with methods
export class UserService {
  async getUser(id: string): Promise<{ id: string }> {
    return { id };
  }

  validate(input: string): boolean {
    return input.length > 0;
  }
}

export { topLevelFn, fetchSomething, arrow, expr };
