import { describe, it, expect } from 'vitest';
import { parseBrowserOrigin, resolveOAuthOrigin } from './beeperOAuthOrigin.js';

// Placeholders throughout — never a host observed on a real install.
const REQUEST_ORIGIN = 'https://localhost:5555';
const CONFIGURED = ['http://localhost:5554', 'https://host-example.example-tailnet.ts.net:5555'];

describe('parseBrowserOrigin', () => {
  it('accepts a bare http(s) origin and refuses anything carrying more than one', () => {
    expect(parseBrowserOrigin('http://localhost:5554')?.origin).toBe('http://localhost:5554');
    expect(parseBrowserOrigin('https://example.com')?.origin).toBe('https://example.com');
    // A trailing slash, a path, a query, credentials and a non-http scheme are
    // all "not an origin" — refused rather than trimmed into one, because the
    // value ends up in `redirect_uri`.
    expect(parseBrowserOrigin('http://localhost:5554/')).toBeNull();
    expect(parseBrowserOrigin('http://localhost:5554/api/beeper')).toBeNull();
    expect(parseBrowserOrigin('http://localhost:5554?next=/x')).toBeNull();
    expect(parseBrowserOrigin('http://user:pass@localhost:5554')).toBeNull();
    expect(parseBrowserOrigin('javascript:alert(1)')).toBeNull();
    expect(parseBrowserOrigin('file:///etc/hosts')).toBeNull();
    expect(parseBrowserOrigin('not a url')).toBeNull();
    expect(parseBrowserOrigin('')).toBeNull();
    expect(parseBrowserOrigin(undefined)).toBeNull();
  });
});

describe('resolveOAuthOrigin', () => {
  // The bug this exists for: under the Vite dev proxy the request arrives with
  // the API's own origin on the API port, so the consent redirect landed the
  // browser on a host the TLS certificate does not cover.
  it('prefers a loopback browser origin over the API origin the proxy makes the request look like', () => {
    expect(resolveOAuthOrigin({
      clientOrigin: 'http://localhost:5554',
      requestOrigin: REQUEST_ORIGIN,
      configuredOrigins: CONFIGURED,
    })).toEqual({ origin: 'http://localhost:5554', source: 'client', rejectedClientOrigin: false });
  });

  it('accepts every loopback spelling, since a dual-stack box resolves them differently', () => {
    for (const origin of ['http://127.0.0.1:5554', 'http://[::1]:5554', 'https://127.0.0.5:8443']) {
      expect(resolveOAuthOrigin({ clientOrigin: origin, requestOrigin: REQUEST_ORIGIN }))
        .toMatchObject({ origin, source: 'client' });
    }
  });

  it('accepts a different port on the host the request itself arrived on', () => {
    // UI and API are different ports of one install — pinning the port would
    // reject exactly the case this fix exists for.
    expect(resolveOAuthOrigin({
      clientOrigin: 'https://host-example.example-tailnet.ts.net:5554',
      requestOrigin: 'https://host-example.example-tailnet.ts.net:5555',
    })).toMatchObject({ origin: 'https://host-example.example-tailnet.ts.net:5554', source: 'client' });
  });

  it('accepts a host named by the configured UI/API origins', () => {
    expect(resolveOAuthOrigin({
      clientOrigin: 'https://host-example.example-tailnet.ts.net:5554',
      requestOrigin: REQUEST_ORIGIN,
      configuredOrigins: CONFIGURED,
    })).toMatchObject({ origin: 'https://host-example.example-tailnet.ts.net:5554', source: 'client' });
  });

  // An https→http downgrade of the redirect origin: the request itself
  // reached this install over TLS, so a client-supplied origin proposing to
  // hand the authorization code back over plaintext HTTP is refused even
  // though the host is otherwise recognized.
  it('refuses an http origin on a non-loopback host when the request arrived over https', () => {
    expect(resolveOAuthOrigin({
      clientOrigin: 'http://host-example.example-tailnet.ts.net:5554',
      requestOrigin: 'https://host-example.example-tailnet.ts.net:5555',
      configuredOrigins: CONFIGURED,
    })).toEqual({
      origin: 'https://host-example.example-tailnet.ts.net:5555',
      source: 'request',
      rejectedClientOrigin: true,
    });
  });

  it('still accepts an http origin on a loopback host even when the request arrived over https', () => {
    expect(resolveOAuthOrigin({
      clientOrigin: 'http://localhost:5554',
      requestOrigin: REQUEST_ORIGIN,
      configuredOrigins: CONFIGURED,
    })).toEqual({ origin: 'http://localhost:5554', source: 'client', rejectedClientOrigin: false });
  });

  it('refuses an unrecognized host and falls back to the request origin', () => {
    // Whatever lands in `redirect_uri` is where Beeper sends the authorization
    // code, so an origin this install does not answer on is never used.
    expect(resolveOAuthOrigin({
      clientOrigin: 'https://example.com',
      requestOrigin: REQUEST_ORIGIN,
      configuredOrigins: CONFIGURED,
    })).toEqual({ origin: REQUEST_ORIGIN, source: 'request', rejectedClientOrigin: true });
  });

  it('refuses a malformed origin and falls back', () => {
    expect(resolveOAuthOrigin({
      clientOrigin: 'http://localhost:5554/api/beeper/oauth/callback',
      requestOrigin: REQUEST_ORIGIN,
    })).toEqual({ origin: REQUEST_ORIGIN, source: 'request', rejectedClientOrigin: true });
  });

  it('falls back silently when no origin was sent at all', () => {
    // An older client is not a rejection — there is nothing to warn about.
    expect(resolveOAuthOrigin({ requestOrigin: REQUEST_ORIGIN }))
      .toEqual({ origin: REQUEST_ORIGIN, source: 'request', rejectedClientOrigin: false });
  });

  it('reports no origin when neither source produced one', () => {
    expect(resolveOAuthOrigin({}))
      .toEqual({ origin: null, source: 'none', rejectedClientOrigin: false });
  });
});
