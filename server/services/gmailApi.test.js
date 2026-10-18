import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auth as googleAuth } from '@googleapis/calendar';
import { createGmailApi } from './gmailApi.js';
import { messageLogError } from '../lib/messageLogError.js';

// Real OAuth client and request pipeline; only the network (fetch) is stubbed,
// so each captured call is exactly what Gmail would receive.
const ORIGIN = 'https://gmail.googleapis.com/gmail/v1/users/me';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let calls;
let answer;
function client({ expired = false } = {}) {
  const oauth = new googleAuth.OAuth2({
    clientId: 'example-client', clientSecret: 'example-secret',
    transporterOptions: {
      fetchImplementation: async (url, init) => {
        const text = init?.body ? String(init.body) : '';
        calls.push({ url: String(url), method: init?.method || 'GET', headers: new Headers(init?.headers), body: text && String(url).startsWith(ORIGIN) ? JSON.parse(text) : undefined });
        return answer(String(url));
      }
    }
  });
  oauth.setCredentials({ access_token: 'example-token', refresh_token: 'example-refresh', expiry_date: expired ? 1 : Date.now() + 3_600_000 });
  return oauth;
}

beforeEach(() => {
  calls = [];
  answer = () => json(200, { ok: true });
});

describe('Gmail adapter HTTP contract', () => {
  it('lists send-as aliases with a bearer token', async () => {
    answer = () => json(200, { sendAs: [{ sendAsEmail: 'alice@example.com' }] });
    expect(await createGmailApi(client()).listSendAs()).toEqual({ sendAs: [{ sendAsEmail: 'alice@example.com' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${ORIGIN}/settings/sendAs`, method: 'GET' });
    expect(calls[0].headers.get('authorization')).toBe('Bearer example-token');
  });

  it('builds list queries with URLSearchParams and omits an absent page token', async () => {
    const api = createGmailApi(client());
    await api.listMessages({ q: 'in:sent newer_than:14d & x=1', maxResults: 100, pageToken: 'next/page+1' });
    await api.listMessages({ q: 'in:inbox', maxResults: 5 });
    const first = new URL(calls[0].url);
    expect(first.origin + first.pathname).toBe(`${ORIGIN}/messages`);
    expect(Object.fromEntries(first.searchParams)).toEqual({ q: 'in:sent newer_than:14d & x=1', maxResults: '100', pageToken: 'next/page+1' });
    expect([...new URL(calls[1].url).searchParams.keys()]).toEqual(['q', 'maxResults']);
  });

  it('escapes message IDs and repeats metadataHeaders', async () => {
    await createGmailApi(client()).getMessage('a/b?c#d', { format: 'metadata', metadataHeaders: ['Message-ID', 'Subject'] });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/gmail/v1/users/me/messages/a%2Fb%3Fc%23d');
    expect(url.searchParams.get('format')).toBe('metadata');
    expect(url.searchParams.getAll('metadataHeaders')).toEqual(['Message-ID', 'Subject']);
  });

  it('posts send, trash and modify with explicit methods and JSON bodies', async () => {
    const api = createGmailApi(client());
    await api.sendMessage({ raw: 'ZXhhbXBsZQ', threadId: 'thread-1' }, { retry: false });
    await api.trashMessage('m/1');
    await api.modifyMessage('m/1', { removeLabelIds: ['INBOX'] });
    expect(calls.map(c => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ['POST', '/gmail/v1/users/me/messages/send', { raw: 'ZXhhbXBsZQ', threadId: 'thread-1' }],
      ['POST', '/gmail/v1/users/me/messages/m%2F1/trash', undefined],
      ['POST', '/gmail/v1/users/me/messages/m%2F1/modify', { removeLabelIds: ['INBOX'] }]
    ]);
    expect(calls[0].headers.get('content-type')).toContain('application/json');
  });

  it('surfaces provider errors with their HTTP status and no credentials or bodies in diagnostics', async () => {
    answer = () => json(403, { error: { code: 403, message: 'Example denied' } });
    const failure = await createGmailApi(client()).sendMessage({ raw: 'c2VjcmV0LWJvZHk' }, { retry: false }).catch(err => err);
    expect(failure.response.status).toBe(403);
    const logged = messageLogError(failure);
    expect(logged).toContain('403');
    for (const secret of ['example-token', 'example-refresh', 'example-secret', 'c2VjcmV0LWJvZHk']) expect(logged).not.toContain(secret);
  });

  it('refreshes an expired token once and then issues exactly one request', async () => {
    answer = (url) => url.includes('oauth2.googleapis.com')
      ? json(200, { access_token: 'refreshed-token', expires_in: 3600 })
      : json(200, { id: 'm1' });
    await createGmailApi(client({ expired: true })).sendMessage({ raw: 'ZXhhbXBsZQ' }, { retry: false });
    const gmailCalls = calls.filter(c => c.url.startsWith(ORIGIN));
    expect(calls.filter(c => c.url.includes('oauth2.googleapis.com'))).toHaveLength(1);
    expect(gmailCalls).toHaveLength(1);
    expect(gmailCalls[0].headers.get('authorization')).toBe('Bearer refreshed-token');
  });

  it('never resubmits a send after a server error, even by default retry policy', async () => {
    answer = () => json(503, { error: { code: 503, message: 'Example backend error' } });
    const failure = await createGmailApi(client()).sendMessage({ raw: 'ZXhhbXBsZQ' }, { retry: false }).catch(err => err);
    expect(failure.response.status).toBe(503);
    expect(calls).toHaveLength(1);
  });
});
