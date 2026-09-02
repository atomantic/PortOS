/**
 * The review-lifecycle prompt hands CoS agents two copy-pasteable `curl`
 * commands aimed at this install's own API. Those must resolve through
 * `localApiBaseUrl()` rather than a hardcoded origin: on an install that ran
 * `npm run setup:cert`, `:5555` is TLS-only and a plain-HTTP request to it dies
 * at the transport layer, so the local-LLM reviewer reports `cli-error` and the
 * challenge-protocol dispute silently cannot be filed (#5656).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/httpsState.js', () => ({
  getHttpsEnabledAtBoot: vi.fn(() => ({ value: false, initialized: true })),
}));

import { getHttpsEnabledAtBoot } from '../../lib/httpsState.js';
import { buildReviewLoopFollowUpSection } from './reviewLifecycle.js';

const metadata = {
  reviewLoopFollowUp: true,
  reviewLoopPRUrl: 'https://github.com/example-org/example-repo/pull/9',
  reviewLoopPRBranch: 'feature-branch',
  reviewLoopPRNumber: 9,
  reviewLoopReviewers: ['lmstudio'],
  sourceTaskId: 'task-example',
};

describe('reviewLifecycle agent-facing API origin', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PORT;
    delete process.env.PORTOS_HTTP_PORT;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('points both agent curl commands at the loopback HTTP mirror when HTTPS is active', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });

    const section = buildReviewLoopFollowUpSection(metadata);

    expect(section).not.toContain(':5555');
    expect(section).toContain('http://127.0.0.1:5553/api/code-review/local');
    expect(section).toContain('http://127.0.0.1:5553/api/cos/tasks/task-example/challenge');
  });

  it('uses the API port directly when HTTPS is off and no mirror is bound', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: false, initialized: true });

    const section = buildReviewLoopFollowUpSection(metadata);

    expect(section).toContain('http://127.0.0.1:5555/api/code-review/local');
    expect(section).toContain('http://127.0.0.1:5555/api/cos/tasks/task-example/challenge');
  });
});
