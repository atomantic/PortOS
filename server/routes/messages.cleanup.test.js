import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';
import { errorEvents } from '../lib/errorHandler.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'messages-cleanup-test-'));
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...makePathsProxy(actual, { dataRoot: tempRoot }),
    atomicWrite: vi.fn(actual.atomicWrite)
  };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});
vi.mock('../services/readinessNotify.js', () => ({ noteReadinessChanged: vi.fn() }));
vi.mock('../services/messageEvaluator.js', () => ({ evaluateMessages: vi.fn(), generateReplyBody: vi.fn() }));
vi.mock('../services/messageSender.js', () => ({ sendDraft: vi.fn() }));
vi.mock('../services/messagePlaywrightSync.js', () => ({
  getSelectors: vi.fn(), updateSelectors: vi.fn(), testSelectors: vi.fn(), launchProvider: vi.fn()
}));
vi.mock('../services/messageActions.js', () => ({ executeAction: vi.fn() }));
vi.mock('../services/messageTriageRules.js', () => ({ listRules: vi.fn(), deleteRule: vi.fn() }));
vi.mock('../services/messageTokenExtractor.js', () => ({
  getToken: vi.fn(), getTokenStatus: vi.fn(), testApi: vi.fn(), clearTokenCache: vi.fn()
}));

const { atomicWrite, PATHS } = await import('../lib/fileUtils.js');
const { atomicWrite: persist } = await vi.importActual('../lib/fileUtils.js');
const { unlink } = await import('fs/promises');
const { unlink: remove } = await vi.importActual('fs/promises');
const accounts = await import('../services/messageAccounts.js');
const drafts = await import('../services/messageDrafts.js');
const sync = await import('../services/messageSync.js');
const { default: routes } = await import('./messages.js');

const io = { emit: vi.fn() };
const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/messages', routes);
const observeError = () => {};
beforeAll(() => errorEvents.on('error', observeError));
afterAll(() => {
  errorEvents.off('error', observeError);
  rmSync(tempRoot, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  atomicWrite.mockReset().mockImplementation(persist);
  unlink.mockReset().mockImplementation(remove);
  io.emit.mockClear();
});

async function seedMailbox() {
  const account = await accounts.createAccount({ name: 'Example mailbox', type: 'gmail' });
  await persist(join(PATHS.messages, 'cache', `${account.id}.json`), {
    messages: [{ id: 'example-message', subject: 'Example subject', bodyText: 'Example mail', date: '2026-01-01' }]
  });
  await drafts.createDraft({ accountId: account.id, to: ['recipient@example.com'], body: 'Example draft' });
  return account.id;
}

describe('mailbox deletion cleanup with isolated persisted stores', () => {
  it.each(['cache unlink', 'draft persistence'])('keeps a disabled account retryable after %s fails', async (failure) => {
    const id = await seedMailbox();
    const storageError = Object.assign(new Error('Synthetic cleanup failure'), { code: 'EACCES' });
    if (failure === 'cache unlink') {
      unlink.mockRejectedValueOnce(storageError);
    } else {
      atomicWrite.mockImplementation(async (path, ...args) => {
        if (path === join(PATHS.messages, 'drafts.json')) throw storageError;
        return persist(path, ...args);
      });
    }

    const failed = await request(app).delete(`/api/messages/accounts/${id}`);
    expect(failed.status).toBe(500);
    expect(await accounts.getAccount(id)).toMatchObject({ id, enabled: false });
    expect(await drafts.listDrafts({ accountId: id })).toHaveLength(1);
    expect((await sync.getMessages()).total).toBe(failure === 'cache unlink' ? 1 : 0);
    expect(io.emit).toHaveBeenCalledWith('error:occurred', expect.objectContaining({ status: 500 }));
    expect(io.emit).not.toHaveBeenCalledWith('messages:changed', expect.anything());
    expect(await sync.syncAccount(id)).toMatchObject({ error: 'Account is disabled' });

    atomicWrite.mockImplementation(persist);
    const retried = await request(app).delete(`/api/messages/accounts/${id}`);
    expect(retried.status).toBe(204);
    expect(await accounts.getAccount(id)).toBeNull();
    expect(await sync.getMessages()).toEqual({ messages: [], total: 0 });
    expect(await drafts.listDrafts()).toEqual([]);
    expect(io.emit).toHaveBeenCalledWith('messages:changed', {});
  });

  it('erases historical orphan stores and treats repeated deletion as a successful no-op', async () => {
    const id = await seedMailbox();
    await accounts.deleteAccount(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(app).delete(`/api/messages/accounts/${id}`);
      expect(response.status).toBe(204);
      expect(await sync.getMessages()).toEqual({ messages: [], total: 0 });
      expect(await drafts.listDrafts()).toEqual([]);
    }
  });
});
