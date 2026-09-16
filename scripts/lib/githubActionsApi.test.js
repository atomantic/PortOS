/**
 * `resolveApiBase` decides which host a step-scoped `GITHUB_TOKEN` is sent to,
 * so these are the tests that used to live — in duplicate — in each calling
 * script's suite.
 */
import { describe, expect, it, vi } from 'vitest';

import { githubRequest, isSuccess, repoApiPath, resolveApiBase } from './githubActionsApi.js';

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
