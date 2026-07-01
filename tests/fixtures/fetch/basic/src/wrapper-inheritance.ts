// Inheritance-chain wrapper fixture (#207). Verifies that a leaf
// subclass with no own `post`/`sendRequest` method still resolves to
// its inherited base method's fetch call.

class BasePostClient {
  constructor(protected url: string) {}
  async post(name: string, body: unknown) {
    return fetch(`${this.url}?r=${name}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}

// One level deep — UserAPI inherits post() from BasePostClient.
class UserAPI extends BasePostClient {}

// Two levels deep — AuthenticatedUserAPI inherits post() from
// BasePostClient via UserAPI.
class AuthenticatedUserAPI extends UserAPI {
  // Adds an override for a different method, but post() is still
  // inherited from the base.
  async getAuthHeader(): Promise<string> {
    return 'Bearer xyz';
  }
}

const userClient = new UserAPI('/api/users');
const authClient = new AuthenticatedUserAPI('/api/auth');

export async function callInheritedOneLevel(id: string) {
  return userClient.post('GetUser', { id });
}

export async function callInheritedTwoLevels(id: string) {
  return authClient.post('GetAuth', { id });
}
