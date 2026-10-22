import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';
import { ACCOUNT_IDS, messageFixture } from '../../scripts/perf/collectionFixtureData.js';

const permissions = vi.hoisted(() => ({ denied: false }));
vi.mock('node:fs/promises', async original => {
  const actual = await original();
  return { ...actual, access: async (...args) => {
    if (permissions.denied) throw Object.assign(new Error('Synthetic access denial'), { code: 'EACCES' });
    return actual.access(...args);
  } };
});
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  const { PATHS } = makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('portos-inbox-summary-') });
  return { ...actual, PATHS, tryReadFile: vi.fn((...args) => permissions.denied ? null : actual.tryReadFile(...args)) };
});

import { PATHS, atomicWrite, tryReadFile } from '../lib/fileUtils.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { deleteCache, getMessages, removeMessageFromCache, updateMessageEvaluations } from '../services/messageSync.js';
import { messageInboxRead, messageDetailRead } from './messageInboxRead.js';

const cacheDir = join(PATHS.messages, 'cache');
const cachePath = id => join(cacheDir, id + '.json');
const app = express();
app.get('/inbox', messageInboxRead);
app.get('/:accountId/:messageId', messageDetailRead);
app.use(errorMiddleware);
const inbox = query => request(app).get('/inbox?summary=true' + (query ? '&' + query : ''));
const seed = async (count = 30) => {
  for (const [account, id] of ACCOUNT_IDS.entries()) {
    await writeFile(cachePath(id), JSON.stringify({ messages: Array.from({ length: count }, (_, i) => messageFixture(id, i + account * count)) }));
  }
};

beforeEach(async () => {
  permissions.denied = false;
  vi.mocked(tryReadFile).mockClear();
  await rm(PATHS.messages, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
});
afterAll(cleanupTempDataRoots);

describe('inbox summary reads through the production HTTP/service boundary', () => {
  it('shares first reads and reuses compact rows across pages without hydrating bodies', async () => {
    await seed();
    const [first, duplicate] = await Promise.all([inbox(), inbox()]);
    const second = await inbox('offset=50');
    expect(first.status).toBe(200);
    expect(duplicate.body).toEqual(first.body);
    expect(first.body.total).toBe(60);
    expect(first.body.messages).toHaveLength(50);
    expect(second.body.messages).toHaveLength(10);
    expect(new Set([...first.body.messages, ...second.body.messages].map(message => message.id)).size).toBe(60);
    expect(tryReadFile).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first.body).length).toBeLessThan(26000);
    expect(first.body.messages[0].preview).toHaveLength(100);
    expect(first.body.messages[0]).not.toHaveProperty('bodyText');
    expect(first.body.messages[0]).not.toHaveProperty('bodyHtml');
    expect(first.body.messages[0].evaluation).not.toHaveProperty('reasoning');
  });

  it('keeps full-body search, legacy reads, lazy details and account filters intact', async () => {
    const id = ACCOUNT_IDS[0];
    const message = { ...messageFixture(id, 1), bodyText: 'x'.repeat(500) + 'unique-body-match',
      from: { name: 'Example Sender', email: 'sender@example.com', detail: 'private detail' } };
    await writeFile(cachePath(id), JSON.stringify({ messages: [message] }));
    await inbox();
    const found = await inbox('search=unique-body-match&accountId=' + id);
    expect(found.body).toMatchObject({ total: 1, messages: [{ id: message.id, preview: 'x'.repeat(100) }] });
    expect(found.body.messages[0].from).toEqual({ name: 'Example Sender', email: 'sender@example.com' });
    expect(found.body.messages[0].evaluation).toEqual({ action: 'review', priority: 'normal' });
    expect((await request(app).get('/inbox')).body.messages).toEqual([message]);
    expect((await request(app).get(`/${id}/${message.id}`)).body).toEqual(message);
    expect((await inbox('accountId=' + ACCOUNT_IDS[1])).body).toEqual({ messages: [], total: 0 });
    expect(tryReadFile).toHaveBeenCalledTimes(5);
  });

  it('observes same-size edits, external replacements, evaluation writes and deletions immediately', async () => {
    const id = ACCOUNT_IDS[0];
    let message = { ...messageFixture(id, 1), bodyText: 'Old' };
    const save = () => writeFile(cachePath(id), JSON.stringify({ messages: [message] }));
    await save();
    expect((await inbox()).body.messages[0].preview).toBe('Old');
    const before = await stat(cachePath(id));
    message = { ...message, bodyText: 'New' };
    await save();
    await utimes(cachePath(id), before.atime, before.mtime);
    expect((await inbox()).body.messages[0].preview).toBe('New');
    message = { ...message, bodyText: 'Replacement' };
    await atomicWrite(cachePath(id), { messages: [message] });
    expect((await inbox()).body.messages[0].preview).toBe('Replacement');
    await updateMessageEvaluations({ [message.id]: { action: 'keep', priority: 'low', reasoning: 'Full detail' } });
    expect((await inbox()).body.messages[0].evaluation).toEqual({ action: 'keep', priority: 'low' });
    await removeMessageFromCache(id, message.id);
    expect((await inbox()).body).toEqual({ messages: [], total: 0 });
    await deleteCache(id);
    expect((await inbox()).body).toEqual({ messages: [], total: 0 });
  });

  it('does not publish a stale first read over a concurrent committed evaluation', async () => {
    const id = ACCOUNT_IDS[0];
    const message = messageFixture(id, 1);
    await writeFile(cachePath(id), JSON.stringify({ messages: [message] }));
    let started;
    let release;
    const reading = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    vi.mocked(tryReadFile).mockImplementationOnce(async file => {
      const content = await readFile(file, 'utf8');
      started();
      await held;
      return content;
    });
    const first = getMessages({ accountId: id, summary: true });
    await reading;
    const joined = getMessages({ accountId: id, summary: true });
    try {
      await updateMessageEvaluations({ [message.id]: { action: 'keep', priority: 'high' } });
    } finally { release(); }
    expect((await first).messages[0].evaluation).toEqual({ action: 'keep', priority: 'high' });
    expect(await joined).toEqual(await first);
    expect((await inbox()).body.messages[0].evaluation).toEqual({ action: 'keep', priority: 'high' });
    expect(tryReadFile).toHaveBeenCalledTimes(3);
  });

  it('rejects repeated query fields as a validation error before reading any cache', async () => {
    await seed(1);
    const repeated = [
      'search=first&search=second',
      `accountId=${ACCOUNT_IDS[0]}&accountId=${ACCOUNT_IDS[1]}`,
      'summary=true&summary=false'
    ];
    for (const query of repeated) {
      const response = await request(app).get('/inbox?' + query);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    }
    expect(tryReadFile).not.toHaveBeenCalled();
  });

  it('never serves old summaries after unreadable, corrupt, missing or empty caches', async () => {
    const id = ACCOUNT_IDS[0];
    const restore = () => writeFile(cachePath(id), JSON.stringify({ messages: [messageFixture(id, 1)] }));
    await restore();
    expect((await inbox()).body.total).toBe(1);
    permissions.denied = true;
    expect((await inbox()).body).toEqual({ messages: [], total: 0 });
    permissions.denied = false;
    expect((await inbox()).body.total).toBe(1);
    await writeFile(cachePath(id), '{invalid');
    expect((await inbox()).body).toEqual({ messages: [], total: 0 });
    await restore();
    expect((await inbox()).body.total).toBe(1);
    await rm(cachePath(id));
    expect((await inbox()).body).toEqual({ messages: [], total: 0 });
    await writeFile(cachePath(id), JSON.stringify({ messages: [] }));
    await inbox();
    vi.mocked(tryReadFile).mockClear();
    expect((await inbox()).body).toEqual({ messages: [], total: 0 });
    expect(tryReadFile).not.toHaveBeenCalled();
  });

  it.skipIf(process.env.PORTOS_INBOX_BENCHMARK !== '1')('measures repeated 4000-message HTTP pages without timing gates', async () => {
    await seed(2000);
    const bytes = (await Promise.all(ACCOUNT_IDS.map(async id => (await stat(cachePath(id))).size))).reduce((a, b) => a + b);
    const measure = async summary => {
      vi.mocked(tryReadFile).mockClear();
      const durations = [];
      for (let page = 0; page < 8; page++) {
        const start = performance.now();
        const response = await request(app).get(`/inbox?summary=${summary}&offset=${page * 50}`);
        expect(response.body.total).toBe(4000);
        expect(response.body.messages).toHaveLength(50);
        durations.push(performance.now() - start);
      }
      return { reads: vi.mocked(tryReadFile).mock.calls.length,
        medianWarmMs: durations.slice(1).sort((a, b) => a - b)[3] };
    };
    const legacy = await measure(false);
    const summary = await measure(true);
    expect(legacy.reads).toBe(16);
    expect(summary.reads).toBe(2);
    process.stdout.write(JSON.stringify({ synthetic: true, messages: 4000, pageLimit: 50, pages: 8,
      bytesPerFullRead: bytes, legacy, summary, eliminatedReadBytes: bytes * 7 }) + '\n');
  });
});
