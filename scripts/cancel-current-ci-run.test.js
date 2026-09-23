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

/**
 * Issue 7574: cancelling the run stops the failing job before GitHub records
 * its `failure` conclusion, so the annotation printed here is the ONLY surface
 * that survives to name the culprit. These cover the ordering that makes that
 * true, and the contract that a broken diagnostic never costs the cancel.
 */
describe('reportFailureBeforeCancel', () => {
  const ANNOTATION_ENV = { ...ENV, GITHUB_JOB: 'windows-server', CI_FAILED_SHARD: '3' };
  const JOBS_URL = 'https://api.github.com/repos/example/portos/actions/runs/123456789/jobs?per_page=100';
  const CANCEL_URL = 'https://api.github.com/repos/example/portos/actions/runs/123456789/cancel';
  const jobsResponse = (jobs) => ({ ok: true, status: 200, json: async () => ({ jobs }) });
  const FAILED_RUN = [
    { name: 'Server tests (1/2)', conclusion: 'cancelled', steps: [{ name: 'Run server tests', conclusion: 'cancelled' }] },
    {
      name: 'Windows server unit tests (3/3)',
      conclusion: 'cancelled',
      steps: [
        { name: 'Checkout', conclusion: 'success' },
        { name: 'Run server tests on Windows', conclusion: 'failure' },
      ],
    },
  ];

  it('annotates the failing job and step BEFORE it asks for the cancel', async () => {
    const { fetchImpl, logger } = setup();
    const summaries = [];
    fetchImpl.mockImplementation((url) => (
      url === JOBS_URL ? Promise.resolve(jobsResponse(FAILED_RUN)) : Promise.resolve(response(202))
    ));

    await cancelCurrentCiRun({
      env: ANNOTATION_ENV, fetchImpl, logger, writeSummary: (markdown) => summaries.push(markdown),
    });

    const annotation = logger.log.mock.calls.map(([line]) => line).find((line) => line.startsWith('::error'));
    expect(annotation).toContain('Windows server unit tests (3/3) — failed step: Run server tests on Windows');
    // Ordering is the whole point: a cancel that lands first can kill this job
    // mid-step, and an unwritten annotation explains nothing.
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([JOBS_URL, CANCEL_URL]);
    expect(summaries[0]).toContain('Run server tests on Windows');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still names this job and shard when the step lookup is unavailable', async () => {
    // The fallback is why the workflow passes the shard in: `GITHUB_JOB` alone
    // cannot tell three identical Windows rows apart.
    const { fetchImpl, logger } = setup();
    fetchImpl.mockImplementation((url) => (
      url === JOBS_URL ? Promise.reject(new Error('network unavailable')) : Promise.resolve(response(202))
    ));

    await expect(cancelCurrentCiRun({ env: ANNOTATION_ENV, fetchImpl, logger }))
      .resolves.toEqual({ outcome: 'requested', status: 202 });

    const annotation = logger.log.mock.calls.map(([line]) => line).find((line) => line.startsWith('::error'));
    expect(annotation).toContain('windows-server (shard 3)');
  });

  it('names the crashed test file in the fallback when a native Vitest worker crash killed the step (issue 8152)', async () => {
    // `run-ci-tests.js` writes CI_CRASHED_TEST_FILE via $GITHUB_ENV when a
    // worker crash reproduces on retry — the failing-step lookup can't see
    // this itself because the crash killed the step before Actions recorded
    // a per-step failure the jobs API can read back.
    const { fetchImpl, logger } = setup();
    fetchImpl.mockImplementation((url) => (
      url === JOBS_URL ? Promise.reject(new Error('network unavailable')) : Promise.resolve(response(202))
    ));

    await cancelCurrentCiRun({
      env: { ...ANNOTATION_ENV, CI_CRASHED_TEST_FILE: 'server/services/sprites/importer.test.js' },
      fetchImpl,
      logger,
    });

    const annotation = logger.log.mock.calls.map(([line]) => line).find((line) => line.startsWith('::error'));
    expect(annotation).toContain('server/services/sprites/importer.test.js');
    expect(annotation).not.toContain('open this job\'s log');
  });

  it('annotates even when the environment cannot authorize a cancel', async () => {
    const { fetchImpl, logger } = setup();

    await expect(cancelCurrentCiRun({ env: { GITHUB_JOB: 'lint' }, fetchImpl, logger }))
      .resolves.toEqual({ outcome: 'skipped', reason: 'invalid-environment' });

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('::error'));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('lint'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still attempts the cancel when the annotation path throws', async () => {
    // The script runs after a real failure. A diagnostic that takes the cancel
    // down with it would cost money on every red build.
    const { fetchImpl } = setup();
    const logger = {
      log: vi.fn((line) => {
        if (String(line).startsWith('::error')) throw new Error('stdout closed');
      }),
      error: vi.fn(),
    };
    fetchImpl.mockResolvedValue(response(202));

    await expect(cancelCurrentCiRun({ env: ANNOTATION_ENV, fetchImpl, logger }))
      .resolves.toMatchObject({ outcome: 'requested' });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('annotation'));
    expect(fetchImpl).toHaveBeenCalledWith(CANCEL_URL, expect.objectContaining({ method: 'POST' }));
  });

  it('keeps a workflow-sourced name from forging its own workflow command', async () => {
    // Job and step names come from a workflow file, and Actions reads a leading
    // `::` as a command — so a name must never be able to open one.
    const { fetchImpl, logger } = setup();
    fetchImpl.mockImplementation((url) => (
      url === JOBS_URL
        ? Promise.resolve(jobsResponse([{
          name: 'evil\n::error::forged',
          steps: [{ name: 'step', conclusion: 'failure' }],
        }]))
        : Promise.resolve(response(202))
    ));

    await cancelCurrentCiRun({ env: ANNOTATION_ENV, fetchImpl, logger });

    const printed = logger.log.mock.calls.map(([line]) => line).filter((line) => line.startsWith('::error'));
    expect(printed).toHaveLength(1);
    expect(printed[0]).not.toContain('::error::forged');
    expect(printed[0]).toContain('evil');
  });
});
