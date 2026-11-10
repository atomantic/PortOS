import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  verifyReviewerIdentities,
  IDENTITY_STATUS,
  __resetReviewerIdentityCache,
} from './reviewerIdentity.js';

describe('reviewerIdentity (#15603)', () => {
  const notFound = () =>
    Object.assign(new Error('gh: Not Found (HTTP 404)'), {
      ghNoAccess: true,
      ghStderr: 'gh: Not Found (HTTP 404)',
    });

  beforeEach(() => {
    __resetReviewerIdentityCache();
  });

  it('resolves to verified when users/<owner> is 404 but users/<owner>[bot] exists', async () => {
    const ghApi = vi.fn().mockImplementation(async (args) => {
      const path = args.at(-1);
      if (path === 'users/my-app') throw notFound();
      if (path === `users/${encodeURIComponent('my-app[bot]')}`) return JSON.stringify({ login: 'my-app[bot]', type: 'Bot' });
      throw notFound();
    });

    const res = await verifyReviewerIdentities(['my-app'], { ghApi });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      token: 'my-app',
      status: IDENTITY_STATUS.VERIFIED,
    });
    expect(ghApi).toHaveBeenCalledTimes(2);
    expect(ghApi.mock.calls[0][0]).toContain('users/my-app');
    expect(ghApi.mock.calls[1][0]).toContain(`users/${encodeURIComponent('my-app[bot]')}`);
  });

  it('resolves to missing when both users/<owner> and users/<owner>[bot] are 404', async () => {
    const ghApi = vi.fn().mockRejectedValue(notFound());

    const res = await verifyReviewerIdentities(['ghost-reviewer'], { ghApi });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      token: 'ghost-reviewer',
      status: IDENTITY_STATUS.MISSING,
      reason: 'GitHub user "ghost-reviewer" does not exist on github.com',
    });
    expect(ghApi).toHaveBeenCalledTimes(2);
  });

  it('resolves to unavailable when a transport error occurs on either lookup', async () => {
    const ghApiTimeout = vi.fn().mockImplementation(async (args) => {
      const path = args.at(-1);
      if (path === 'users/flaky-app') throw notFound();
      throw new Error('gh command timed out after 8000ms');
    });

    const res1 = await verifyReviewerIdentities(['flaky-app'], { ghApi: ghApiTimeout });
    expect(res1[0]).toMatchObject({
      token: 'flaky-app',
      status: IDENTITY_STATUS.UNAVAILABLE,
      reason: 'gh command timed out after 8000ms',
    });

    const ghApiFirstTimeout = vi.fn().mockRejectedValue(new Error('network down'));
    const res2 = await verifyReviewerIdentities(['network-fail'], { ghApi: ghApiFirstTimeout });
    expect(res2[0]).toMatchObject({
      token: 'network-fail',
      status: IDENTITY_STATUS.UNAVAILABLE,
      reason: 'network down',
    });
    expect(ghApiFirstTimeout).toHaveBeenCalledTimes(1);
  });
});
