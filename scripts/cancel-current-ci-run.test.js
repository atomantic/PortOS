import { describe, expect, it, vi } from 'vitest';

import { cancelCurrentCiRun } from './cancel-current-ci-run.js';

const ENV = {
  GITHUB_REPOSITORY: 'example/portos',
  GITHUB_RUN_ID: '123456789',
  GITHUB_TOKEN: 'ephemeral-test-token',
};

const response = (status) => ({ ok: status >= 200 && status < 300, status });

function setup() {
  return {
    fetchImpl: vi.fn(),
    logger: { log: vi.fn(), error: vi.fn() },
  };
}

describe('cancelCurrentCiRun', () => {
  it('cancels the current repository run with the step-scoped token', async () => {
    const { fetchImpl, logger } = setup();
    fetchImpl.mockResolvedValue(response(202));

    await expect(cancelCurrentCiRun({ env: ENV, fetchImpl, logger })).resolves.toEqual({
      outcome: 'requested',
      status: 202,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/portos/actions/runs/123456789/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ephemeral-test-token',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('treats an already-terminal run as a successful no-op', async () => {
    const { fetchImpl, logger } = setup();
    fetchImpl.mockResolvedValue(response(409));

    await expect(cancelCurrentCiRun({ env: ENV, fetchImpl, logger })).resolves.toEqual({
      outcome: 'already-terminal',
      status: 409,
    });

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('uses the Actions API base and falls back to the public API when it is absent', async () => {
    const { fetchImpl, logger } = setup();
    fetchImpl.mockResolvedValue(response(202));

    await cancelCurrentCiRun({
      env: { ...ENV, GITHUB_API_URL: 'https://github.example.test/api/v3/' },
      fetchImpl,
      logger,
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://github.example.test/api/v3/repos/example/portos/actions/runs/123456789/cancel',
      expect.any(Object),
    );

    fetchImpl.mockClear();
    await cancelCurrentCiRun({ env: ENV, fetchImpl, logger });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/portos/actions/runs/123456789/cancel',
      expect.any(Object),
    );
  });

  it('rejects an unsafe API base without making a request', async () => {
    const { fetchImpl, logger } = setup();

    await expect(cancelCurrentCiRun({
      env: { ...ENV, GITHUB_API_URL: 'http://example.invalid/api/v3' },
      fetchImpl,
      logger,
    })).resolves.toEqual({ outcome: 'skipped', reason: 'invalid-environment' });

    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(cancelCurrentCiRun({
      env: { ...ENV, GITHUB_API_URL: 'not-a-url' },
      fetchImpl,
      logger,
    })).resolves.toEqual({ outcome: 'skipped', reason: 'invalid-environment' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps a permission failure best-effort and preserves the original job failure', async () => {
    const { fetchImpl, logger } = setup();
    fetchImpl.mockResolvedValue(response(403));

    await expect(cancelCurrentCiRun({ env: ENV, fetchImpl, logger })).resolves.toEqual({
      outcome: 'unavailable',
      status: 403,
    });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('403'));
  });

  it('keeps a network failure best-effort', async () => {
    const { fetchImpl, logger } = setup();
    fetchImpl.mockRejectedValue(new Error('network unavailable'));

    await expect(cancelCurrentCiRun({ env: ENV, fetchImpl, logger })).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'request-failed',
    });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('network unavailable'));
  });

  it('does not make a request when the target cannot come from Actions environment', async () => {
    const { fetchImpl, logger } = setup();

    await expect(cancelCurrentCiRun({
      env: { ...ENV, GITHUB_REPOSITORY: 'https://example.invalid/other', GITHUB_RUN_ID: 'run-from-args' },
      fetchImpl,
      logger,
    })).resolves.toEqual({ outcome: 'skipped', reason: 'invalid-environment' });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('environment'));
  });
});
