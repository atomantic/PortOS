import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const getProviderById = vi.fn();
const getAppById = vi.fn();
vi.mock('../provider/providers.js', () => ({ getProviderById: (...a) => getProviderById(...a) }));
vi.mock('../apps.js', () => ({ getAppById: (...a) => getAppById(...a) }));

const { runJobPreflight } = await import('./preflight.js');

const repo = mkdtempSync(join(tmpdir(), 'preflight-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

beforeEach(() => {
  getProviderById.mockReset();
  getAppById.mockReset();
});

describe('runJobPreflight', () => {
  it('passes an unpinned agent job without touching providers or apps', async () => {
    expect(await runJobPreflight({ id: 'j', type: 'agent' })).toEqual({ ok: true });
    expect(getProviderById).not.toHaveBeenCalled();
    expect(getAppById).not.toHaveBeenCalled();
  });

  it('blocks a pinned provider that is missing, disabled or lacks its API key', async () => {
    getProviderById.mockResolvedValueOnce(null);
    expect(await runJobPreflight({ type: 'agent', providerId: 'gone' })).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });

    getProviderById.mockResolvedValueOnce({ id: 'p', type: 'cli', enabled: false });
    expect(await runJobPreflight({ type: 'agent', providerId: 'p' })).toMatchObject({ ok: false, reason: expect.stringContaining('disabled') });

    getProviderById.mockResolvedValueOnce({ id: 'p', type: 'api', enabled: true, endpoint: 'https://api.example.com/v1', apiKey: '' });
    expect(await runJobPreflight({ type: 'agent', providerId: 'p' })).toMatchObject({ ok: false, reason: expect.stringContaining('no credential') });
  });

  it('passes a pinned provider that holds its credential', async () => {
    getProviderById.mockResolvedValueOnce({ id: 'p', type: 'api', enabled: true, endpoint: 'https://api.example.com/v1', apiKey: 'k-live-123' });
    expect(await runJobPreflight({ type: 'agent', providerId: 'p' })).toEqual({ ok: true });
  });

  it('blocks an app that is unknown, has no repoPath, or whose repo is gone', async () => {
    getAppById.mockResolvedValueOnce(null);
    expect(await runJobPreflight({ type: 'agent', appId: 'a' })).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });

    getAppById.mockResolvedValueOnce({ id: 'a' });
    expect(await runJobPreflight({ type: 'agent', appId: 'a' })).toMatchObject({ ok: false, reason: expect.stringContaining('no repoPath') });

    getAppById.mockResolvedValueOnce({ id: 'a', repoPath: join(repo, 'missing') });
    expect(await runJobPreflight({ type: 'agent', appId: 'a' })).toMatchObject({ ok: false, reason: expect.stringContaining('missing on disk') });

    getAppById.mockResolvedValueOnce({ id: 'a', repoPath: repo });
    expect(await runJobPreflight({ type: 'agent', appId: 'a' })).toEqual({ ok: true });
  });

  it('blocks shell jobs with an empty or disallowed command and script jobs with an unknown handler', async () => {
    expect(await runJobPreflight({ type: 'shell', command: '  ' })).toMatchObject({ ok: false });
    expect(await runJobPreflight({ type: 'shell', command: 'rm -rf /' })).toMatchObject({ ok: false, reason: expect.stringContaining('rejected') });
    expect(await runJobPreflight({ type: 'shell', command: 'git status' })).toEqual({ ok: true });
    expect(await runJobPreflight({ type: 'script', scriptHandler: 'no-such-handler' })).toMatchObject({ ok: false, reason: expect.stringContaining('not registered') });
  });
});
