/**
 * The review-lifecycle prompt hands CoS agents a copy-pasteable `curl` command
 * aimed at this install's own API for the challenge protocol. That must resolve
 * through `localApiBaseUrl()` rather than a hardcoded origin: on an install that
 * ran `npm run setup:cert`, `:5555` is TLS-only and a plain-HTTP request to it
 * dies at the transport layer, so the challenge-protocol dispute silently cannot
 * be filed (#5656). The local-LLM reviewer itself goes through the
 * auth-independent local-review bridge (`server/scripts/run-local-code-review.mjs`)
 * instead of an HTTP call, so it needs no origin and no credential at all (#7670).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/httpsState.js', () => ({
  getHttpsEnabledAtBoot: vi.fn(() => ({ value: false, initialized: true })),
}));

import { getHttpsEnabledAtBoot } from '../../lib/httpsState.js';
import { buildReviewLoopFollowUpSection, prepareSandboxedReviewLoopBody } from './reviewLifecycle.js';
import { buildLocalReviewerInstructions } from '../cosTaskPrompts.js';

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
    getHttpsEnabledAtBoot.mockReturnValue({ value: false, initialized: true });
    delete process.env.PORT;
    delete process.env.PORTOS_HTTP_PORT;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('reports CLI health from claims and review loops without giving reviewers the token', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });
    const sections = [
      buildLocalReviewerInstructions(['opencode', 'codex']),
      buildReviewLoopFollowUpSection({ ...metadata, reviewLoopReviewers: ['opencode', 'codex'], reviewLoopOptionalReviewers: ['opencode'] }),
    ];
    for (const section of sections) {
      expect(section).toContain('http://127.0.0.1:5553/api/code-review/cli-outcome');
      expect(section).toContain('-H "Authorization: Bearer ${PORTOS_API_TOKEN:-}"');
      expect(section).toContain('never pass it or these reporting instructions to a reviewer');
      expect(section).toContain('A recorded failure is INCONCLUSIVE, never clean');
      expect(section).toContain('preserve the configured reviewer list and optional-review policy');
    }
    expect(buildLocalReviewerInstructions(['ollama'])).not.toContain('/cli-outcome');
  });

  it('points the challenge-protocol curl at the loopback HTTP mirror when HTTPS is active', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });

    const section = buildReviewLoopFollowUpSection(metadata);

    expect(section).not.toContain(':5555');
    expect(section).toContain('http://127.0.0.1:5553/api/cos/tasks/task-example/challenge');
  });

  it('uses the API port directly when HTTPS is off and no mirror is bound', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: false, initialized: true });

    const section = buildReviewLoopFollowUpSection(metadata);

    expect(section).toContain('http://127.0.0.1:5555/api/cos/tasks/task-example/challenge');
  });
});

describe('reviewLifecycle reviewer invocation details', () => {
  beforeEach(() => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: false, initialized: true });
  });

  // The route validates `backend` against a z.enum of the local-LLM reviewers, so
  // a leftover `<lmstudio|ollama>` placeholder in a run configured for MTPLX is a
  // 400 the agent has to guess its way out of.
  it('names the local backend this run actually configured', () => {
    const section = buildReviewLoopFollowUpSection({ ...metadata, reviewLoopReviewers: ['mtplx'] });
    expect(section).toContain('backend: "mtplx"');
    expect(section).not.toContain('<lmstudio|ollama>');
    expect(section).not.toContain('Substitute the active reviewer name');
  });

  it('keeps a substitution placeholder when several local backends are configured', () => {
    const section = buildReviewLoopFollowUpSection({ ...metadata, reviewLoopReviewers: ['ollama', 'mtplx'] });
    expect(section).toContain('backend: "<ollama|mtplx>"');
    expect(section).toContain('Substitute the active reviewer name');
  });

  // The challenge-protocol curl hits `/api/*`, which the optional instance
  // password gates. An agent holds no browser cookie, so without the injected
  // session token the dispute came back `401 AUTH_REQUIRED` and read as a
  // broken protocol (#7660 follow-on). The whole header is one quoted argument
  // so a token can never be word-split, and the `:-` default keeps the command
  // valid on an install with no password set.
  it('spends the injected loopback session token on the challenge-protocol curl', () => {
    const section = buildReviewLoopFollowUpSection(metadata);
    const authHeader = '-H "Authorization: Bearer ${PORTOS_API_TOKEN:-}"';

    expect(section).toContain(`/api/cos/tasks/task-example/challenge -H 'Content-Type: application/json' ${authHeader}`);
  });

  // #7670: the local-LLM reviewer drives the same auth-independent stdin bridge
  // the claim prompt already uses — no HTTP route, no 401, no credential.
  it('pipes the local-LLM reviewer through the stdin bridge, not the HTTP route', () => {
    const section = buildReviewLoopFollowUpSection(metadata);

    expect(section).not.toContain('/api/code-review/local');
    expect(section).not.toContain('An `HTTP 401` is not a review result');
    expect(section).toContain('run-local-code-review.mjs');
    expect(section).toContain('timeoutMs: 1800000');
  });

  // `opencode run -m <provider/model>`: rendering `--model` here had agents
  // probing for a flag OpenCode does not document.
  it('renders each CLI reviewer\'s own model flag', () => {
    const section = buildReviewLoopFollowUpSection({
      ...metadata,
      reviewLoopReviewers: ['opencode', 'codex'],
      reviewLoopReviewerModels: { opencode: 'mtplx/qwen38', codex: 'gpt-5.6-sol' },
    });
    expect(section).toContain('`opencode -m mtplx/qwen38 …`');
    expect(section).toContain('`codex --model gpt-5.6-sol …`');
  });
});

describe('public review CLI procedure sanitization', () => {
  it('keeps a native read-only invocation when the recipe supports it', () => {
    const body = prepareSandboxedReviewLoopBody(
      'codex --sandbox danger-full-access -a never exec "$CODEX_APPLY_PROMPT"',
    );

    expect(body).toContain('codex ');
    expect(body).toContain('--sandbox read-only review');
    expect(body).not.toContain('danger-full-access');
    expect(body).not.toContain('exec');
  });

  it('falls back to the supported agy procedure without inventing isolation flags', () => {
    const body = prepareSandboxedReviewLoopBody(
      'agy --dangerously-skip-permissions --model "$AGY_REVIEW_MODEL" --print-timeout 30m -p "$LOCAL_PROMPT"',
    );

    expect(body).toContain('agy --model "$AGY_REVIEW_MODEL" --print-timeout 30m --mode plan --sandbox -p "$LOCAL_PROMPT"');
    expect(body).not.toContain('Reviewer unavailable');
    expect(body).not.toContain('--dangerously-skip-permissions');
  });

  it('fails closed when no maintained procedure can be recognized', () => {
    const body = prepareSandboxedReviewLoopBody('codex --danger-full-access exec "$LOCAL_PROMPT"');

    expect(body).toContain('Reviewer unavailable');
  });
});
