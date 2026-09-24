// Stop an unmocked happy-dom fetch before it reaches its localhost test origin.
// A caller may catch the rejection as an ordinary offline state, so the test
// runner must also check takeError() after each test.
export function createUnexpectedFetchGuard(testName) {
  const requests = new Map();

  const fetch = (input) => {
    let path = '<invalid URL>';
    try {
      const target = typeof input === 'string' || input instanceof URL ? input : input?.url;
      path = new URL(target, 'http://test.invalid').pathname;
    } catch {
      // Keep malformed input out of reports as well.
    }
    const owner = testName() || '<outside a test>';
    const key = `${owner}: ${path}`;
    requests.set(key, (requests.get(key) || 0) + 1);
    return Promise.reject(new Error(`Unexpected test fetch in ${key}`));
  };

  const takeError = () => {
    if (requests.size === 0) return null;
    const entries = [...requests];
    requests.clear();
    const first = entries.slice(0, 5).map(([key, count]) => `${key} (${count}x)`);
    const remaining = entries.length - first.length;
    return new Error(`Unexpected test fetch; mock this request or use an owned fixture: ${first.join(', ')}${remaining ? `, and ${remaining} more` : ''}`);
  };

  return { fetch, takeError };
}
