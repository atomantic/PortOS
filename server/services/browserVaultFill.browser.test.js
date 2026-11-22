/**
 * Real-Chrome proof of the model-blind website-login fill (#17397): the page
 * scripts, isolated world, frame-tree origin checks and navigation detection
 * run against real documents over a real CDP session (Playwright's, wrapped to
 * the filler's `{ send, on, close }` boundary). Pages are served from
 * Playwright routes, so `https://` origins exist without a network.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun, resolveTestChrome } from '../lib/browserSuiteGate.js';
import { startOwnedBrowserFixture } from '../test/browserFixture.js';
import { clearEphemeralSecrets, scrubSecretTokens } from '../lib/secretText.js';
import { createBrowserVaultFiller } from './browserVaultFill.js';

const chrome = resolveTestChrome();
const canRun = browserSuiteCanRun('Browser vault fill', { Chrome: chrome });

const ORIGIN = 'https://login.example.com';
const USERNAME = 'Alice.Example@example.com';
const PASSWORD = 'pw-correct-horse-battery-9271';
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII "12345678901234567890"
// t = 31 s is HOTP counter 1 for a 30 s step: RFC 4226's 287082.
const FIXED_NOW = 31_000;
const EXPECTED_CODE = '287082';
const LOGIN_ID = '00000000-0000-4000-8000-0000000000aa';

const trackInputs = `<script>
  window.state = {}; window.trusted = {}; window.submitted = 0;
  // composedPath()[0] is the real input even when the event crossed a shadow root.
  document.addEventListener('input', (event) => {
    const input = event.composedPath()[0];
    window.state[input.id] = input.value;
    window.trusted[input.id] = event.isTrusted;
  }, true);
  document.addEventListener('submit', (event) => { event.preventDefault(); window.submitted++; }, true);
</script>`;

const LOGIN_FORM = `<form id="login">
  <input id="search" name="q" placeholder="Search the site">
  <input id="user" type="email" name="email" autocomplete="username">
  <input id="pw" type="password" autocomplete="current-password">
  <input id="otp" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6">
  <button type="submit">Sign in</button>
</form>`;

const PAGES = {
  [`${ORIGIN}/signin`]: `<!doctype html><html><body>${LOGIN_FORM}${trackInputs}</body></html>`,
  // Look-alike origin: an exact-origin check must refuse a suffix match.
  'https://login.example.com.evil.test/signin': `<!doctype html><html><body>${LOGIN_FORM}${trackInputs}</body></html>`,
  // A hostile page spoofing the origin readers the page could reach.
  'https://evil.test/signin': `<!doctype html><html><body>${LOGIN_FORM}${trackInputs}<script>
    const fake = { origin: '${ORIGIN}' };
    Object.defineProperty(Document.prototype, 'defaultView', { get() { return { top: null, location: fake, HTMLInputElement, Event, getComputedStyle }; } });
    Object.defineProperty(Document.prototype, 'location', { get() { return fake; } });
  </script></body></html>`,
  // Navigates away the moment a password arrives.
  [`${ORIGIN}/navigates`]: `<!doctype html><html><body>${LOGIN_FORM}${trackInputs}<script>
    document.getElementById('pw').addEventListener('input', () => { location.href = 'https://other.example/landing'; });
  </script></body></html>`,
  'https://other.example/landing': '<!doctype html><html><body>elsewhere</body></html>',
  // Reverts the password shortly after it is set.
  [`${ORIGIN}/reverts`]: `<!doctype html><html><body>${LOGIN_FORM}${trackInputs}<script>
    document.getElementById('pw').addEventListener('input', (e) => { setTimeout(() => { e.target.value = ''; }, 30); });
  </script></body></html>`,
  // The only login form lives in a cross-origin iframe.
  [`${ORIGIN}/framed`]: `<!doctype html><html><body><iframe id="auth" src="https://auth.example.net/form"></iframe>${trackInputs}</body></html>`,
  'https://auth.example.net/form': `<!doctype html><html><body>${LOGIN_FORM}${trackInputs}</body></html>`,
  // A web-component form inside an open shadow root.
  [`${ORIGIN}/shadow`]: `<!doctype html><html><body><login-box></login-box>${trackInputs}<script>
    customElements.define('login-box', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = \`${LOGIN_FORM}\`; }
    });
  </script></body></html>`,
};

describe.skipIf(!canRun)('model-blind website-login fill in real Chrome', () => {
  let fixture;
  beforeAll(async () => { fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } }); }, 30000);
  afterAll(() => fixture?.close());
  afterEach(() => clearEphemeralSecrets());

  async function openTab(url) {
    const context = await fixture.browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', (route) => {
      const body = PAGES[route.request().url().split('#')[0]];
      return body ? route.fulfill({ contentType: 'text/html', body }) : route.abort();
    });
    const page = await context.newPage();
    await page.goto(url);
    return { context, page };
  }

  function fillerFor(context, page, { reportedUrl, origins = [ORIGIN] } = {}) {
    const readLogin = vi.fn(async () => ({
      username: USERNAME, password: PASSWORD, totp: { secret: SEED, algorithm: 'SHA1', digits: 6, period: 30 },
    }));
    const filler = createBrowserVaultFiller({
      listPages: async () => [{ id: 'tab-1', type: 'page', url: reportedUrl ?? page.url() }],
      openSession: async () => {
        const cdp = await context.newCDPSession(page);
        return { send: (method, params) => cdp.send(method, params), on: (event, fn) => cdp.on(event, fn), close: () => { cdp.detach().catch(() => {}); } };
      },
      getLogin: async () => ({ id: LOGIN_ID, origins, hasTotp: true }),
      readLogin,
      settleMs: 150,
      now: () => FIXED_NOW,
    });
    return { filler, readLogin };
  }

  const pageState = (page) => page.evaluate(() => ({
    state: window.state, trusted: window.trusted, submitted: window.submitted,
    values: Object.fromEntries([...document.querySelectorAll('input')].map((el) => [el.id, el.value])),
  }));

  it('fills identifier, password and TOTP on the exact origin with a secret-free result', async () => {
    const { context, page } = await openTab(`${ORIGIN}/signin`);
    try {
      const { filler } = fillerFor(context, page);
      const result = await filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID, fields: ['totp', 'identifier', 'password'] });
      expect(result).toEqual({
        ok: true, loginId: LOGIN_ID, targetId: 'tab-1', origin: ORIGIN,
        filledFields: ['identifier', 'password', 'totp'], identifierFilled: true, totpFilled: true, submitted: false,
      });
      const serialized = JSON.stringify(result);
      for (const secret of [USERNAME, PASSWORD, SEED, EXPECTED_CODE]) expect(serialized).not.toContain(secret);

      const { state, trusted, submitted, values } = await pageState(page);
      expect(values).toEqual({ search: '', user: USERNAME, pw: PASSWORD, otp: EXPECTED_CODE });
      // The page's own listeners saw every value; the identifier arrived as trusted typing.
      expect(state).toMatchObject({ user: USERNAME, pw: PASSWORD, otp: EXPECTED_CODE });
      expect(trusted.user).toBe(true);
      expect(submitted).toBe(0);

      // The injected secrets are now scrubbed from anything echoed back to a model.
      expect(scrubSecretTokens(`page said ${PASSWORD} and ${EXPECTED_CODE}`)).toBe('page said [REDACTED] and [REDACTED]');
    } finally { await context.close(); }
  }, 30000);

  it('finds a form inside an open shadow root', async () => {
    const { context, page } = await openTab(`${ORIGIN}/shadow`);
    try {
      const { filler } = fillerFor(context, page);
      await expect(filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID })).resolves.toMatchObject({ filledFields: ['identifier', 'password'] });
      const values = await page.evaluate(() => [...document.querySelector('login-box').shadowRoot.querySelectorAll('input')].map((el) => el.value));
      expect(values).toEqual(['', USERNAME, PASSWORD, '']);
      // A listener outside the shadow root saw both values: the identifier as
      // trusted typing, the password through a composed synthetic input event.
      const { state, trusted } = await pageState(page);
      expect(state).toEqual({ user: USERNAME, pw: PASSWORD });
      expect(trusted).toEqual({ user: true, pw: false });
    } finally { await context.close(); }
  }, 30000);

  it.each([
    ['a look-alike suffix origin', 'https://login.example.com.evil.test/signin', undefined],
    // The target list is stale/lying; the browser-reported frame origin still refuses.
    ['a page spoofing its origin readers', 'https://evil.test/signin', `${ORIGIN}/signin`],
  ])('refuses %s before decrypting anything', async (_label, url, reportedUrl) => {
    const { context, page } = await openTab(url);
    try {
      const { filler, readLogin } = fillerFor(context, page, { reportedUrl });
      await expect(filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID })).rejects.toMatchObject({ code: 'ORIGIN_MISMATCH' });
      expect(readLogin).not.toHaveBeenCalled();
      expect((await pageState(page)).values).toEqual({ search: '', user: '', pw: '', otp: '' });
    } finally { await context.close(); }
  }, 30000);

  it('refuses when the page navigates away mid-fill', async () => {
    const { context, page } = await openTab(`${ORIGIN}/navigates`);
    try {
      const { filler } = fillerFor(context, page);
      const error = await filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID }).catch((e) => e);
      expect(error.code).toBe('NAVIGATED_DURING_FILL');
      expect(error.message).not.toContain(PASSWORD);
    } finally { await context.close(); }
  }, 30000);

  it('refuses when the page reverts a value during the settle window', async () => {
    const { context, page } = await openTab(`${ORIGIN}/reverts`);
    try {
      const { filler } = fillerFor(context, page);
      await expect(filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID })).rejects.toMatchObject({ code: 'VALUE_NOT_RETAINED' });
    } finally { await context.close(); }
  }, 30000);

  it('never reaches a login form inside a cross-origin iframe', async () => {
    const { context, page } = await openTab(`${ORIGIN}/framed`);
    try {
      await page.frameLocator('#auth').locator('#pw').waitFor();
      const { filler, readLogin } = fillerFor(context, page);
      await expect(filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID })).rejects.toMatchObject({ code: 'FIELD_NOT_FOUND' });
      expect(readLogin).not.toHaveBeenCalled();
      const frameValues = await page.frame({ url: 'https://auth.example.net/form' })
        .evaluate(() => [...document.querySelectorAll('input')].map((el) => el.value));
      expect(frameValues).toEqual(['', '', '', '']);
    } finally { await context.close(); }
  }, 30000);
});
