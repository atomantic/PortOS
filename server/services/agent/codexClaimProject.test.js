import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'path';
import { groupCodexClaimProject } from './codexClaimProject.js';

const repoPath = resolve('example', 'PortOS');
const workspacePath = resolve('example', 'worktrees', 'issue-42');
const otherCheckout = resolve('example', 'worktrees', 'issue-43');
const startedAt = 1_800_000_000_123;
const rootThread = { id: '019c1234-1000-7000-8000-000000000042', cwd: workspacePath, createdAt: 1_800_000_000 };
const project = (id, path) => ({ id, roots: [{ path }] });

function run(request, overrides = {}) {
  return groupCodexClaimProject({
    request, repoPath, workspacePath, appName: 'PortOS', startedAt, sourceKind: 'cli',
    waits: [0], now: () => startedAt + 5000, ...overrides,
  });
}

describe('Codex claim project assignment', () => {
  it('reuses a project by repository root, not by name, and retains the claim cwd', async () => {
    const request = vi.fn(async (method) => ({
      'thread/list': { data: [rootThread, { ...rootThread, id: '019c1234-1000-7000-8000-000000000043', cwd: otherCheckout }] },
      'project/list': { data: [{ ...project('matching-root', repoPath), name: 'Renamed by operator' },
        { ...project('same-name-other-root', otherCheckout), name: 'PortOS' }] },
      'thread/metadata/update': { thread: { ...rootThread, projectId: 'matching-root' } },
    })[method]);
    expect(await run(request)).toEqual({ status: 'grouped' });
    expect(request).toHaveBeenCalledWith('thread/list', { cwd: workspacePath, sourceKinds: ['cli'], limit: 30 });
    expect(request).toHaveBeenCalledWith('thread/metadata/update', { threadId: rootThread.id, projectId: 'matching-root' });
    expect(request.mock.calls.some(([method]) => method === 'project/create')).toBe(false);
  });

  it('creates one idempotent project for two distinct worktrees of the same app', async () => {
    const request = vi.fn(async (method, params) => {
      if (method === 'thread/list') return { data: [{ ...rootThread, cwd: params.cwd }] };
      if (method === 'project/list') return { data: [] };
      if (method === 'project/create') return { project: project('shared', repoPath) };
      return { thread: { projectId: 'shared' } };
    });
    const result = await Promise.all([run(request), run(request, { workspacePath: otherCheckout, sourceKind: 'exec' })]);
    expect(result).toEqual([{ status: 'grouped' }, { status: 'grouped' }]);
    const create = request.mock.calls.filter(([method]) => method === 'project/create').map(([, params]) => params);
    expect(create).toHaveLength(2); // same idempotency key is one create on the app-server
    expect(create[0]).toEqual(create[1]);
    expect(create[0]).toMatchObject({ name: 'PortOS', roots: [{ path: repoPath }] });
  });

  it('does not touch a previously started, ambiguous, or manually assigned thread', async () => {
    const old = vi.fn(async () => ({ data: [{ ...rootThread, createdAt: rootThread.createdAt - 1 }] }));
    expect(await run(old)).toEqual({ status: 'not-found' });
    expect(old).toHaveBeenCalledTimes(1);
    const conflicting = vi.fn(async () => ({ data: [rootThread, { ...rootThread, id: '019c1234-1000-7000-8000-000000000043' }] }));
    expect(await run(conflicting)).toEqual({ status: 'ambiguous' });
    expect(conflicting).toHaveBeenCalledTimes(1);
    const assigned = vi.fn(async method => method === 'thread/list'
      ? { data: [{ ...rootThread, projectId: 'operator-project' }] } : { data: [project('app', repoPath)] });
    expect(await run(assigned)).toEqual({ status: 'already-assigned' });
    expect(assigned).toHaveBeenCalledTimes(2);
  });

  it('retries only the lookup until Codex persists an empty new thread and moves checkout-only grouping', async () => {
    const request = vi.fn(async method => {
      if (method === 'thread/list') return { data: [{ ...rootThread, projectId: 'own-checkout' }] };
      if (method === 'project/list') return { data: [project('app', repoPath), project('own-checkout', workspacePath)] };
      return { thread: { projectId: 'app' } };
    }).mockResolvedValueOnce({ data: [] });
    const sleep = vi.fn(async () => {});
    expect(await run(request, { waits: [0, 10], sleep })).toEqual({ status: 'grouped' });
    expect(sleep).toHaveBeenCalledWith(10);
    expect(request).toHaveBeenCalledWith('thread/metadata/update', { threadId: rootThread.id, projectId: 'app' });
  });
});
