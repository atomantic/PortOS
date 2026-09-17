/**
 * `resolveApiBase` decides which host a step-scoped `GITHUB_TOKEN` is sent to,
 * so these are the tests that used to live — in duplicate — in each calling
 * script's suite.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  fetchJobsWithFailedSteps, githubRequest, isSuccess, repoApiPath, resolveApiBase,
} from './githubActionsApi.js';

describe('resolveApiBase', () => {
  it('defaults to the public API when GITHUB_API_URL is absent', () => {
    expect(resolveApiBase(undefined)).toBe('https://api.github.com');
    expect(resolveApiBase('   ')).toBe('https://api.github.com');
  });

  it('accepts a GitHub Enterprise base and strips its trailing slashes', () => {
    expect(resolveApiBase('https://github.example.test/api/v3/')).toBe('https://github.example.test/api/v3');
  });

  it.each([
    ['plaintext http', 'http://example.invalid/api/v3'],
    ['an unparseable value', 'not-a-url'],
    ['embedded credentials', 'https://user:pass@example.invalid/api/v3'],
    // A query or fragment is silently dropped once a path is appended, so the
    // request would not go to the URL the caller read.
    ['a query string', 'https://example.invalid/api/v3?token=x'],
    ['a fragment', 'https://example.invalid/api/v3#x'],
  ])('refuses %s', (_label, value) => {
    expect(resolveApiBase(value)).toBeNull();
  });
});

describe('repoApiPath', () => {
  it('builds the repo path from GITHUB_REPOSITORY alone', () => {
    expect(repoApiPath({ GITHUB_REPOSITORY: 'example-owner/example-repo' }))
      .toBe('https://api.github.com/repos/example-owner/example-repo');
  });

  it.each([
    ['a URL smuggled into the slug', 'https://example.invalid/other'],
    ['a missing repo segment', 'example-owner'],
    ['whitespace in a segment', 'example owner/repo'],
    ['nothing at all', ''],
  ])('rejects %s', (_label, repository) => {
    expect(repoApiPath({ GITHUB_REPOSITORY: repository })).toBeNull();
  });

  it('refuses to build a path when the API base is refused', () => {
    expect(repoApiPath({
      GITHUB_REPOSITORY: 'example-owner/example-repo',
      GITHUB_API_URL: 'http://example.invalid',
    })).toBeNull();
  });
});

describe('githubRequest', () => {
  it('sends the standard Actions headers and an abort signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await githubRequest(fetchImpl, 'https://api.github.com/x', 'token-value', { method: 'POST' });

    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/x', {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer token-value',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: expect.any(AbortSignal),
    });
    // timeoutMs configures the signal; it must not leak into fetch's init.
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('timeoutMs');
  });

  it('lets a caller add a header but never rewrite the three fixed ones', async () => {
    // A POST body needs its Content-Type; `Authorization` decides which host
    // the step-scoped token is sent to, so it must not be caller-settable.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    await githubRequest(fetchImpl, 'https://api.github.com/x', 'token-value', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer stolen',
        // Mixed case matters: fetch folds every spelling into ONE header, and
        // these survive both a case-sensitive filter AND the fixed-key overwrite,
        // so they would be APPENDED to Authorization/Accept rather than dropped.
        AUTHORIZATION: 'Bearer stolen-upper',
        ACCEPT: 'text/html',
      },
    });

    expect(fetchImpl.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer token-value',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });
});

describe('isSuccess', () => {
  it.each([[200, true], [202, true], [299, true], [304, false], [403, false], [500, false]])(
    'reads status %i as %s', (status, expected) => {
      expect(isSuccess({ status, ok: status >= 200 && status < 300 })).toBe(expected);
    },
  );

  it('accepts a stub that reports only one of status or ok', () => {
    expect(isSuccess({ ok: true })).toBe(true);
    expect(isSuccess({ status: 201 })).toBe(true);
    expect(isSuccess(null)).toBe(false);
  });
});

describe('fetchJobsWithFailedSteps', () => {
  const TARGET = {
    repoPath: 'https://api.github.com/repos/example/portos',
    runId: '123456789',
    token: 'ephemeral-test-token',
  };
  const jobs = (value) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => value });

  it('names the failed steps of a job GitHub recorded as cancelled', () => {
    // The fail-fast cancel lands before the job's `failure` conclusion is
    // written, so the step conclusions are the only surviving evidence (7574).
    return expect(fetchJobsWithFailedSteps(jobs({
      jobs: [
        { name: 'Server tests (1/2)', conclusion: 'cancelled', steps: [{ name: 'Run', conclusion: 'cancelled' }] },
        {
          name: 'Windows server unit tests (3/3)',
          conclusion: 'cancelled',
          steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'Run tests', conclusion: 'failure' }],
        },
      ],
    }), TARGET)).resolves.toEqual([
      { name: 'Windows server unit tests (3/3)', steps: ['Run tests'] },
    ]);
  });

  it('separates "nothing failed" from "could not look"', async () => {
    // Both callers turn a non-empty list into a red verdict and `[]` into a
    // cancelled one. Collapsing null into `[]` would be invisible there and
    // would silently re-hide the failure this lookup exists to surface.
    await expect(fetchJobsWithFailedSteps(jobs({ jobs: [] }), TARGET)).resolves.toEqual([]);

    for (const fetchImpl of [
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
      vi.fn().mockRejectedValue(new Error('network unavailable')),
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
      undefined,
    ]) {
      await expect(fetchJobsWithFailedSteps(fetchImpl, TARGET)).resolves.toBeNull();
    }

    const unused = jobs({ jobs: [] });
    await expect(fetchJobsWithFailedSteps(unused, { ...TARGET, token: '' })).resolves.toBeNull();
    await expect(fetchJobsWithFailedSteps(unused, { ...TARGET, runId: 'not-a-run' })).resolves.toBeNull();
    expect(unused).not.toHaveBeenCalled();
  });
});
