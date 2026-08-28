/**
 * `findMergeRequestForBranch` — the GitLab mirror of the GitHub PR lookup the
 * agent PR-claim verification uses (#3358). Same three-state contract: asking
 * and getting nothing must never be confused with not being able to ask.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
// `execFile` is unused here, but gitlab.js reaches safeJSONParse through
// lib/fileUtils.js, which promisifies it at module load — a spawn-only mock
// makes the import itself throw.
vi.mock('../lib/childProcess.js', () => ({
  spawn: (...args) => spawnMock(...args),
  execFile: () => { throw new Error('execFile is not used by gitlab.js'); },
}));

const { findMergeRequestForBranch, execGlabJson } = await import('./gitlab.js');

/** A fake `glab` child that writes `stdout` then exits with `code`. */
const glabChild = ({ code = 0, stdout = '' } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
};

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => glabChild({ code: 0, stdout: '[]' }));
});

describe('findMergeRequestForBranch (#3358)', () => {
  it('reports `found` with the MR iid', async () => {
    spawnMock.mockImplementationOnce(() => glabChild({
      stdout: '[{"iid":12,"web_url":"https://gitlab.example/g/p/-/merge_requests/12","description":"Closes #1","state":"opened"}]'
    }));
    await expect(findMergeRequestForBranch('claim/issue-1', '/repo'))
      .resolves.toMatchObject({ status: 'found', number: 12, body: 'Closes #1' });
  });

  it('queries by source branch across every state, asking for JSON with the long --output form', async () => {
    await findMergeRequestForBranch('claim/issue-1', '/repo');
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(args).toEqual(['mr', 'list', '--source-branch', 'claim/issue-1', '--all', '-P', '1', '--output', 'json']);
    expect(opts.cwd).toBe('/repo');
  });

  it('reports `none` for an ANSWERED empty list', async () => {
    await expect(findMergeRequestForBranch('claim/issue-1', '/repo'))
      .resolves.toMatchObject({ status: 'none', number: null });
  });

  it('reports `unavailable` — never `none` — when glab fails', async () => {
    spawnMock.mockImplementationOnce(() => glabChild({ code: 1 }));
    await expect(findMergeRequestForBranch('claim/issue-1', '/repo'))
      .resolves.toMatchObject({ status: 'unavailable' });
  });

  it('reports `unavailable` when a zero-exit glab emits unparseable output', async () => {
    spawnMock.mockImplementationOnce(() => glabChild({ stdout: 'not json' }));
    await expect(findMergeRequestForBranch('claim/issue-1', '/repo'))
      .resolves.toMatchObject({ status: 'unavailable' });
  });

  it('never spawns without a branch or a repo path', async () => {
    await expect(findMergeRequestForBranch('', '/repo')).resolves.toMatchObject({ status: 'unavailable' });
    await expect(findMergeRequestForBranch('b', '')).resolves.toMatchObject({ status: 'unavailable' });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('execGlab timeout (#3358)', () => {
  it('kills a stalled glab and resolves null instead of hanging the caller', async () => {
    // Without this bound, the agent PR-claim verification that awaits an MR
    // lookup would strand a finishing run forever on a hung keychain/network.
    vi.useFakeTimers();
    const hung = new EventEmitter();
    hung.stdout = new EventEmitter();
    hung.stderr = new EventEmitter();
    hung.kill = vi.fn();
    spawnMock.mockImplementationOnce(() => hung);

    const pending = findMergeRequestForBranch('claim/issue-1', '/repo');
    await vi.advanceTimersByTimeAsync(60000);
    expect(hung.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(pending).resolves.toMatchObject({ status: 'unavailable' });

    // A late close must not flip the already-settled result.
    hung.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
    vi.useRealTimers();
  });
});

describe('execGlabJson', () => {
  it('appends the JSON flag itself so no caller can re-copy the wrong one', async () => {
    await execGlabJson(['issue', 'list', '--per-page', '100'], '/repo');
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual(['issue', 'list', '--per-page', '100', '--output', 'json']);
  });

  it('returns the parsed rows on an answered list', async () => {
    spawnMock.mockImplementationOnce(() => glabChild({ stdout: '[{"iid":7}]' }));
    await expect(execGlabJson(['issue', 'list'], '/repo'))
      .resolves.toEqual({ rows: [{ iid: 7 }], reason: 'ok' });
  });

  it('an ANSWERED empty list is rows:[] / ok — never conflated with a failed read', async () => {
    await expect(execGlabJson(['issue', 'list'], '/repo'))
      .resolves.toEqual({ rows: [], reason: 'ok' });
  });

  it('reports `cli-failed` when glab exits non-zero (unauthenticated / offline / missing)', async () => {
    spawnMock.mockImplementationOnce(() => glabChild({ code: 1 }));
    await expect(execGlabJson(['issue', 'list'], '/repo'))
      .resolves.toEqual({ rows: null, reason: 'cli-failed' });
  });

  it('reports `not-json` — NOT `cli-failed` — when glab exits 0 with its human table', async () => {
    // The exact regression: a working, authenticated glab whose output flag
    // moved answers with a table at exit 0. Collapsing that into the
    // reachability failure is what produced the false "retry once the CLI is
    // authenticated" advice.
    spawnMock.mockImplementationOnce(() => glabChild({
      stdout: 'Showing 12 open issues in group/proj (Page 1)\n\n#356\tSomething\t(plan)\t1 hour ago'
    }));
    await expect(execGlabJson(['issue', 'list'], '/repo'))
      .resolves.toEqual({ rows: null, reason: 'not-json' });
  });

  it('a JSON OBJECT is not a row list either', async () => {
    spawnMock.mockImplementationOnce(() => glabChild({ stdout: '{"message":"404 Not Found"}' }));
    await expect(execGlabJson(['issue', 'list'], '/repo'))
      .resolves.toEqual({ rows: null, reason: 'not-json' });
  });
});
