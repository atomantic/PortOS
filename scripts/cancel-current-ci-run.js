#!/usr/bin/env node

/**
 * Best-effort cancellation for the workflow run executing this step.
 *
 * The workflow deliberately supplies no target arguments. The repository and
 * run id come only from GitHub Actions' environment, so a PR cannot redirect
 * this request to another run or repository through script arguments.
 *
 * This script runs after a real CI failure. Cancellation errors must never
 * replace the original failure, so every unavailable/invalid path returns
 * normally after emitting a single diagnostic line.
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';

const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_API_BASE = 'https://api.github.com';
const CANCELLATION_TIMEOUT_MS = 10_000;

function targetFromEnv(env) {
  const repository = typeof env.GITHUB_REPOSITORY === 'string'
    ? env.GITHUB_REPOSITORY.trim()
    : '';
  const runId = typeof env.GITHUB_RUN_ID === 'string'
    ? env.GITHUB_RUN_ID.trim()
    : '';
  const token = typeof env.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';

  if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !/^\d+$/.test(runId) || !token) {
    return null;
  }

  const [owner, repo] = repository.split('/');
  return {
    token,
    url: `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/cancel`,
  };
}

/**
 * Ask GitHub to cancel the workflow run containing this step.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - Actions environment to read.
 * @param {typeof fetch} [options.fetchImpl] - Injectable fetch for tests.
 * @param {{log?: Function, error?: Function}} [options.logger] - Injectable logger.
 * @returns {Promise<{outcome: string, status?: number, reason?: string}>}
 */
export async function cancelCurrentCiRun({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const target = targetFromEnv(env);
  if (!target) {
    logger.error?.('⚠️ CI run cancellation skipped: required GitHub Actions environment is unavailable');
    return { outcome: 'skipped', reason: 'invalid-environment' };
  }

  if (typeof fetchImpl !== 'function') {
    logger.error?.('⚠️ CI run cancellation unavailable: fetch is not available');
    return { outcome: 'unavailable', reason: 'fetch-unavailable' };
  }

  try {
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${target.token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(CANCELLATION_TIMEOUT_MS),
    });
    const status = Number(response?.status) || 0;

    if ((status >= 200 && status < 300) || response?.ok === true) {
      logger.log?.('🛑 Requested cancellation of the current CI run');
      return { outcome: 'requested', status };
    }

    if (status === 409) {
      logger.log?.('ℹ️ Current CI run is already terminal; sibling cancellation was unnecessary');
      return { outcome: 'already-terminal', status };
    }

    logger.error?.(`⚠️ Could not cancel the current CI run: GitHub API returned ${status || 'an unknown status'}`);
    return { outcome: 'unavailable', status };
  } catch (error) {
    logger.error?.(`⚠️ Could not cancel the current CI run: ${error?.message || 'network request failed'}`);
    return { outcome: 'unavailable', reason: 'request-failed' };
  }
}

if (isDirectlyInvoked(import.meta.url)) {
  await cancelCurrentCiRun();
}
