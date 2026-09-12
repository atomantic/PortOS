import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolveForgeForRepo: vi.fn(),
}));

vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: mocks.spawn,
}));

vi.mock('./forgeAuth.js', () => ({
  resolveForgeForRepo: mocks.resolveForgeForRepo,
  resolveForgeTokenEnv: vi.fn(),
}));

import { createPR, mergePR, requestCopilotReview } from './git.js';

const pinnedEnv = { GH_TOKEN: 'test-owner-token' };

function hungChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('bounded forge mutations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.resolveForgeForRepo.mockResolvedValue({
      cli: 'gh',
      env: pinnedEnv,
      host: 'github.com',
      owner: 'example-owner',
      account: 'example-owner',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['createPR', ['pr', 'create'], () => createPR('/repo', { title: 'Title', body: 'Body', base: 'main', head: 'topic' })],
    ['mergePR', ['pr', 'merge', '42', '--merge', '--delete-branch'], () => mergePR('/repo', 42)],
    ['requestCopilotReview', ['api', 'repos/example-owner/repo/pulls/42/requested_reviewers'], () => requestCopilotReview('/repo', 'https://github.com/example-owner/repo/pull/42')],
  ])('kills a stalled gh process and returns a structured timeout from %s', async (_name, expectedArgs, invoke) => {
    const child = hungChild();
    mocks.spawn.mockReturnValue(child);

    const pending = invoke();
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(60000);

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('timed out after 60000ms'),
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mocks.spawn).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(expectedArgs),
      expect.objectContaining({ cwd: '/repo', env: expect.objectContaining({ GH_TOKEN: 'test-owner-token', PWD: '/repo' }) }),
    );
  });

  it('bounds GitLab MR creation with the resolved forge environment', async () => {
    mocks.resolveForgeForRepo.mockResolvedValue({
      cli: 'glab',
      env: { GITLAB_TOKEN: 'test-token' },
      host: 'gitlab.example.com',
      owner: 'example-owner',
      account: null,
    });
    const child = hungChild();
    mocks.spawn.mockReturnValue(child);

    const pending = createPR('/repo', { title: 'Title', body: 'Body', base: 'main', head: 'topic' });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(60000);

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('timed out'),
      cli: 'glab',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mocks.spawn).toHaveBeenCalledWith(
      'glab',
      expect.arrayContaining(['mr', 'create']),
      { cwd: '/repo', shell: false, env: { GITLAB_TOKEN: 'test-token', PWD: '/repo' } },
    );
  });

  it('preserves gh stderr so no-commit cleanup still recognizes its contract', async () => {
    const child = hungChild();
    mocks.spawn.mockReturnValue(child);

    const pending = createPR('/repo', { title: 'Title', body: 'Body', base: 'main', head: 'topic' });
    await vi.dynamicImportSettled();
    child.stderr.emit('data', Buffer.from('GraphQL: No commits between main and topic'));
    child.emit('close', 1);

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: 'GraphQL: No commits between main and topic',
    });
  });

  it.each([
    ['gh', 'https://github.com/example-owner/repo/pull/42\n'],
    ['glab', 'Creating merge request...\nhttps://gitlab.example.com/example-owner/repo/-/merge_requests/42\n'],
  ])('returns the trailing PR URL after a successful %s create', async (cli, stdout) => {
    mocks.resolveForgeForRepo.mockResolvedValue({
      cli,
      env: pinnedEnv,
      host: cli === 'gh' ? 'github.com' : 'gitlab.example.com',
      owner: 'example-owner',
      account: cli === 'gh' ? 'example-owner' : null,
    });
    const child = hungChild();
    mocks.spawn.mockReturnValue(child);

    const pending = createPR('/repo', { title: 'Title', body: 'Body', base: 'main', head: 'topic' });
    await vi.dynamicImportSettled();
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);

    await expect(pending).resolves.toMatchObject({
      success: true,
      url: expect.stringContaining('/42'),
      cli,
    });
  });
});
