/**
 * Protocol-level refusals of the model-blind fill (#17397) against a scripted
 * CDP session. Page behaviour (isolated world, origin spoofing, navigation,
 * iframes) is proven in real Chrome by browserVaultFill.browser.test.js.
 */

import { describe, it, expect, vi } from 'vitest';
import { createBrowserVaultFiller } from './browserVaultFill.js';

const LOGIN_ID = '00000000-0000-4000-8000-0000000000bb';
const ORIGIN = 'https://login.example.com';
const PASSWORD = 'pw-scripted-session-5521';

function scriptedSession({ onSend = () => undefined } = {}) {
  const calls = [];
  return {
    calls,
    session: {
      send: vi.fn(async (method, params) => {
        calls.push(method);
        const scripted = onSend(method, params);
        if (scripted !== undefined) return scripted;
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'l1', securityOrigin: ORIGIN } } };
        return {};
      }),
      on: vi.fn(),
      close: vi.fn(),
    },
  };
}

function makeFiller({ pages, login = { id: LOGIN_ID, origins: [ORIGIN], hasTotp: false }, session } = {}) {
  const readLogin = vi.fn(async () => ({ username: 'alice@example.com', password: PASSWORD, totp: null }));
  const openSession = vi.fn(async () => session ?? scriptedSession().session);
  const filler = createBrowserVaultFiller({
    listPages: async () => pages ?? [{ id: 'tab-1', type: 'page', url: `${ORIGIN}/signin` }],
    openSession,
    getLogin: async () => login,
    readLogin,
    settleMs: 0,
  });
  return { filler, readLogin, openSession };
}

describe('createBrowserVaultFiller refusals', () => {
  it('404s an unknown tab and never treats a non-page target as one', async () => {
    const { filler } = makeFiller({ pages: [{ id: 'tab-1', type: 'service_worker', url: `${ORIGIN}/sw.js` }] });
    await expect(filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID })).rejects.toMatchObject({ code: 'BROWSER_TAB_NOT_FOUND', status: 404 });
  });

  it('refuses from the target list before opening a session when the listed origin is not allowed', async () => {
    const { filler, openSession, readLogin } = makeFiller({ pages: [{ id: 'tab-1', type: 'page', url: 'https://www.login.example.com/' }] });
    await expect(filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID })).rejects.toMatchObject({ code: 'ORIGIN_MISMATCH', status: 403 });
    expect(openSession).not.toHaveBeenCalled();
    expect(readLogin).not.toHaveBeenCalled();
  });

  it('refuses a TOTP fill for a login without a seed before touching the browser', async () => {
    const { filler, openSession } = makeFiller();
    await expect(filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID, fields: ['totp'] })).rejects.toMatchObject({ code: 'LOGIN_HAS_NO_TOTP' });
    expect(openSession).not.toHaveBeenCalled();
  });

  it('allows one fill per tab at a time', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { session } = scriptedSession({ onSend: (method) => (method === 'Page.enable' ? gate.then(() => ({})) : undefined) });
    const { filler } = makeFiller({ session });
    const first = filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID }).catch((error) => error);
    await expect(filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID })).rejects.toMatchObject({ code: 'BROWSER_FILL_BUSY' });
    release();
    await first;
  });

  it('maps a raw CDP failure to a fixed refusal and always closes the session', async () => {
    const { session } = scriptedSession({
      onSend: (method) => {
        if (method === 'Page.createIsolatedWorld') throw Object.assign(new Error(`leaky ${PASSWORD}`), { cdpError: { message: PASSWORD } });
        return undefined;
      },
    });
    const { filler, readLogin } = makeFiller({ session });
    const error = await filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID }).catch((e) => e);
    expect(error).toMatchObject({ code: 'BROWSER_FILL_FAILED', status: 502 });
    expect(error.message).not.toContain(PASSWORD);
    expect(readLogin).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('reports a fill field the page lacks without decrypting', async () => {
    const { session } = scriptedSession({
      onSend: (method) => {
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'Runtime.evaluate') return { result: { objectId: 'doc' } };
        if (method === 'Runtime.callFunctionOn') return { result: { type: 'object', subtype: 'null' } };
        return undefined;
      },
    });
    const { filler, readLogin } = makeFiller({ session });
    await expect(filler.fill({ targetId: 'tab-1', loginId: LOGIN_ID })).rejects.toMatchObject({
      code: 'FIELD_NOT_FOUND', message: expect.stringContaining('identifier, password'),
    });
    expect(readLogin).not.toHaveBeenCalled();
  });
});
