import { describe, it, expect } from 'vitest';

import { ERROR_CATEGORIES } from './aiToolkit/errorDetection.js';
import { CODEX_ERROR_CODES } from './codexAccount.js';
import {
  CODEX_TEXT_THREAD_CONFIG,
  CODEX_TURN_ERROR_CODES,
  CODEX_TURN_NOTIFICATIONS,
  applyCodexTurnEvent,
  classifyCodexTransportError,
  createTurnAccumulator,
  finalizeCodexTurn,
  isCodexTextTransportEnabled,
  normalizeCodexModels,
  normalizeCodexTokenUsage,
  providerDeclaresCodexTextTransport,
  resolveCodexEffort,
} from './codexTurn.js';

const CODEX_CLI = { id: 'codex', type: 'cli', command: 'codex', textTransport: 'codex-app-server' };

describe('the transport capability gate', () => {
  it('separates advertising the capability from being allowed to use it', () => {
    // The shipped seed carries `textTransport` so the Providers page has
    // something to offer; without the explicit opt-in nothing may route here,
    // or updating PortOS would start billing a ChatGPT plan on its own.
    expect(providerDeclaresCodexTextTransport(CODEX_CLI)).toBe(true);
    expect(isCodexTextTransportEnabled(CODEX_CLI)).toBe(false);
    expect(isCodexTextTransportEnabled({ ...CODEX_CLI, textTransportEnabled: true })).toBe(false);
    expect(isCodexTextTransportEnabled({
      ...CODEX_CLI,
      textTransportEnabled: true,
      textTransportReadRiskAcknowledged: true,
    })).toBe(true);
  });

  it('refuses a record that is not the Codex harness, however it is labelled', () => {
    const enabled = {
      ...CODEX_CLI,
      textTransportEnabled: true,
      textTransportReadRiskAcknowledged: true,
    };
    // An API record authenticates with its own stored key and has nothing to do
    // with a subscription.
    expect(isCodexTextTransportEnabled({ ...enabled, type: 'api' })).toBe(false);
    // Repointed at another binary — the flag must not carry over.
    expect(isCodexTextTransportEnabled({ ...enabled, command: 'my-wrapper' })).toBe(false);
    expect(isCodexTextTransportEnabled({ ...enabled, command: '' })).toBe(false);
    expect(isCodexTextTransportEnabled({ ...enabled, enabled: false })).toBe(false);
    expect(isCodexTextTransportEnabled(null)).toBe(false);
  });

  it('matches a renamed clone by its command path', () => {
    expect(isCodexTextTransportEnabled({
      ...CODEX_CLI,
      id: 'codex-review',
      command: '/opt/homebrew/bin/codex',
      textTransportEnabled: true,
      textTransportReadRiskAcknowledged: true,
    })).toBe(true);
  });
});

describe('the generic-text safety envelope', () => {
  it('runs read-only, offline, tool-free, and fail-closed', () => {
    // Every clause here is a boundary a Brain/JIRA summary must not cross —
    // asserted as a unit so loosening one is a deliberate edit, not a drift.
    expect(CODEX_TEXT_THREAD_CONFIG).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      config: { mcp_servers: {}, tools: { web_search: false } },
    });
  });
});

describe('normalizeCodexModels', () => {
  it('throws for a non-catalog so a FAILED read can stay null at the call site', () => {
    // The whole sentinel discipline rests on this: a thrown read leaves the
    // last-known-good list alone, where a returned [] would erase it.
    expect(() => normalizeCodexModels(null)).toThrow();
    expect(() => normalizeCodexModels({})).toThrow();
    expect(() => normalizeCodexModels({ data: 'nope' })).toThrow();
  });

  it('returns [] for a catalog that is genuinely empty', () => {
    expect(normalizeCodexModels({ data: [] })).toEqual({ models: [], nextCursor: null });
  });

  it('keeps the pickable models and drops hidden ones', () => {
    const { models } = normalizeCodexModels({
      data: [
        {
          id: 'model-alpha',
          model: 'model-alpha',
          displayName: 'Model Alpha',
          description: 'A test model',
          isDefault: true,
          hidden: false,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
        },
        { id: 'model-hidden', hidden: true, supportedReasoningEfforts: [] },
        { displayName: 'no id at all' },
      ],
    });

    expect(models).toEqual([{
      id: 'model-alpha',
      displayName: 'Model Alpha',
      description: 'A test model',
      isDefault: true,
      hidden: false,
      defaultEffort: 'medium',
      supportedEfforts: ['low', 'medium'],
      contextWindow: null,
    }]);
  });
});

describe('resolveCodexEffort', () => {
  const model = { id: 'model-alpha', defaultEffort: 'medium', supportedEfforts: ['low', 'medium'] };

  it('passes a supported effort through', () => {
    expect(resolveCodexEffort('low', model)).toMatchObject({ effort: 'low', clamped: false });
  });

  it('clamps visibly to the model default rather than sending a rejected value', () => {
    const resolved = resolveCodexEffort('xhigh', model);
    expect(resolved).toMatchObject({ effort: 'medium', clamped: true });
    expect(resolved.reason).toMatch(/does not support "xhigh"/);
  });

  it('does not clamp against a catalog it has never fetched', () => {
    // `supportedEfforts: []` means UNKNOWN, not "supports nothing" — clamping on
    // it would silently downgrade every call made before the first model/list.
    expect(resolveCodexEffort('xhigh', { id: 'x', supportedEfforts: [] })).toMatchObject({
      effort: 'xhigh', clamped: false,
    });
    expect(resolveCodexEffort('xhigh', null)).toMatchObject({ effort: 'xhigh', clamped: false });
  });

  it('treats an unset effort as "use the provider default"', () => {
    expect(resolveCodexEffort('', model)).toMatchObject({ effort: null, clamped: false });
    expect(resolveCodexEffort(null, model)).toMatchObject({ effort: null, clamped: false });
  });
});

describe('turn projection', () => {
  const delta = (acc, text, extra = {}) =>
    applyCodexTurnEvent(acc, CODEX_TURN_NOTIFICATIONS.agentMessageDelta, { threadId: 't', delta: text, ...extra });
  const complete = (acc, turn) =>
    applyCodexTurnEvent(acc, CODEX_TURN_NOTIFICATIONS.turnCompleted, { threadId: 't', turn });

  it('joins deltas when no completed item supersedes them', () => {
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, 'Hello, ');
    delta(acc, 'world');
    expect(complete(acc, { id: 'turn-1', status: 'completed' })).toBe(true);

    expect(finalizeCodexTurn(acc)).toEqual({ text: 'Hello, world', usage: null });
  });

  it('prefers the completed item text over the deltas that previewed it', () => {
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, '{"partial"');
    applyCodexTurnEvent(acc, CODEX_TURN_NOTIFICATIONS.itemCompleted, {
      threadId: 't', turnId: 'turn-1', item: { type: 'agentMessage', text: '{"whole":true}' },
    });
    complete(acc, { id: 'turn-1', status: 'completed' });

    expect(finalizeCodexTurn(acc).text).toBe('{"whole":true}');
  });

  it('ignores frames belonging to another turn on the same connection', () => {
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, 'mine');
    delta(acc, 'SOMEBODY ELSE', { turnId: 'turn-2' });
    complete(acc, { id: 'turn-1', status: 'completed' });

    expect(finalizeCodexTurn(acc).text).toBe('mine');
  });

  it('keeps running through a retryable error', () => {
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    const terminal = applyCodexTurnEvent(acc, CODEX_TURN_NOTIFICATIONS.error, {
      threadId: 't', turnId: 'turn-1', willRetry: true, error: { message: 'transient' },
    });
    expect(terminal).toBe(false);

    delta(acc, 'recovered');
    complete(acc, { id: 'turn-1', status: 'completed' });
    expect(finalizeCodexTurn(acc).text).toBe('recovered');
  });

  it('NEVER hands back the partial text of an interrupted turn', () => {
    // A half-streamed JSON object that happened to parse would be silently wrong
    // data — worse than a failed call, which the caller can fall back from.
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, '{"answer": "half');
    complete(acc, { id: 'turn-1', status: 'interrupted' });

    expect(finalizeCodexTurn(acc)).toMatchObject({
      category: ERROR_CATEGORIES.CANCELED, canceled: true,
    });
    expect(finalizeCodexTurn(acc).text).toBeUndefined();
  });

  it('NEVER hands back the partial text of a failed turn, and carries its category', () => {
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, 'as much as I got');
    complete(acc, {
      id: 'turn-1',
      status: 'failed',
      error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' },
    });

    const result = finalizeCodexTurn(acc);
    expect(result.text).toBeUndefined();
    expect(result.category).toBe(ERROR_CATEGORIES.USAGE_LIMIT);
  });

  it('treats a completed-but-empty turn as a failure, not a successful blank answer', () => {
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, '   \n ');
    complete(acc, { id: 'turn-1', status: 'completed' });

    expect(finalizeCodexTurn(acc)).toMatchObject({ error: expect.stringMatching(/empty completion/i) });
  });

  it('treats a turn/completed with no status as malformed, not as success', () => {
    // Defaulting an unrecognizable frame to 'completed' would hand the caller
    // whatever had streamed so far as a finished answer — and a caller parsing
    // JSON would get a plausible, wrong object out of half a document.
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, '{"answer":"hal');
    expect(complete(acc, { id: 'turn-1' })).toBe(true);

    const result = finalizeCodexTurn(acc);
    expect(result.text).toBeUndefined();
    expect(result.error).toMatch(/without completing/i);
  });

  it('ignores frames belonging to another thread on the same connection', () => {
    // The routing layer filters by thread too, but this function's contract says
    // it does — and its own callers drive it directly.
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, 'mine');
    applyCodexTurnEvent(acc, CODEX_TURN_NOTIFICATIONS.agentMessageDelta, {
      threadId: 'another-thread', turnId: 'turn-1', delta: 'NOT MINE',
    });
    complete(acc, { id: 'turn-1', status: 'completed' });

    expect(finalizeCodexTurn(acc).text).toBe('mine');
  });

  it('latches the turn id from the first frame that carries one', () => {
    // Without this the caller has no id to `turn/interrupt` with when the
    // `turn/start` response is delayed or lost — and a cancelled turn keeps
    // consuming subscription quota until it ends on its own.
    const acc = createTurnAccumulator({ threadId: 't' });
    delta(acc, 'streaming', { turnId: 'turn-9' });

    expect(acc.turnId).toBe('turn-9');
  });

  it('keeps deltas that arrive after the last completed item', () => {
    // A second agent message with no closing `item/completed` used to vanish:
    // once finalText was set, the delta buffer was ignored entirely.
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, 'preview of one');
    applyCodexTurnEvent(acc, CODEX_TURN_NOTIFICATIONS.itemCompleted, {
      threadId: 't', turnId: 'turn-1', item: { type: 'agentMessage', text: 'message one. ' },
    });
    delta(acc, 'message two.');
    complete(acc, { id: 'turn-1', status: 'completed' });

    // The completed item supersedes its own preview deltas, and does not double.
    expect(finalizeCodexTurn(acc).text).toBe('message one. message two.');
  });

  it('accepts an anonymous completion on its own thread', () => {
    // The frame already reached this accumulator BY THREAD, and PortOS's threads
    // are ephemeral with exactly one turn — so rejecting it over an id the
    // server left off the envelope would discard a finished answer and hang the
    // call until its deadline.
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, 'the answer');
    expect(complete(acc, { status: 'completed' })).toBe(true);

    expect(finalizeCodexTurn(acc).text).toBe('the answer');
  });

  it('latches the turn id from turn/started, the first frame that carries one', () => {
    // A turn that streams no deltas emits nothing else with an id, so without
    // this a lost `turn/start` response leaves it un-interruptible — and
    // cancelling it would keep burning subscription quota.
    const acc = createTurnAccumulator({ threadId: 't' });
    applyCodexTurnEvent(acc, CODEX_TURN_NOTIFICATIONS.turnStarted, {
      threadId: 't', turn: { id: 'turn-7', items: [], status: 'inProgress' },
    });

    expect(acc.turnId).toBe('turn-7');
  });

  it('still ignores a completion that names a different turn', () => {
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    delta(acc, 'mine');
    expect(complete(acc, { id: 'turn-2', status: 'completed' })).toBe(false);

    complete(acc, { id: 'turn-1', status: 'completed' });
    expect(finalizeCodexTurn(acc).text).toBe('mine');
  });

  it('scrubs a credential quoted by a failed turn before it becomes an error', () => {
    // The message becomes a thrown error's text, which aiProvider logs, reports
    // over `ai:status`, and returns to the caller as `{ error }`.
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    complete(acc, {
      id: 'turn-1',
      status: 'failed',
      error: { message: 'upstream rejected access_token=sk-live-ABCDEFGH1234' },
    });

    expect(finalizeCodexTurn(acc).error).not.toContain('sk-live-ABCDEFGH1234');
  });

  it('records token usage under the subscription, with no invented dollar cost', () => {
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    applyCodexTurnEvent(acc, CODEX_TURN_NOTIFICATIONS.tokenUsage, {
      threadId: 't',
      turnId: 'turn-1',
      tokenUsage: {
        // `last` counts only the FINAL model request; a turn that took a
        // reasoning step first would under-report by an order of magnitude.
        // PortOS's threads are ephemeral and carry one turn, so `total` is it.
        last: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 24 },
        total: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 10, reasoningOutputTokens: 5, totalTokens: 160 },
        modelContextWindow: 400000,
      },
    });
    delta(acc, 'answer');
    complete(acc, { id: 'turn-1', status: 'completed' });

    expect(finalizeCodexTurn(acc).usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 160,
      modelContextWindow: 400000,
      source: 'chatgpt-subscription',
    });
    expect(finalizeCodexTurn(acc).usage.cost).toBeUndefined();
  });

  it('normalizes a usage payload with no counts to null rather than a row of zeros', () => {
    expect(normalizeCodexTokenUsage({ last: {} })).toBeNull();
    expect(normalizeCodexTokenUsage(null)).toBeNull();
  });
});

describe('classifyCodexTransportError', () => {
  const cases = [
    ['a quota-exhausted turn', { context: { category: ERROR_CATEGORIES.USAGE_LIMIT } }, ERROR_CATEGORIES.USAGE_LIMIT],
    ['a missing runtime', { code: CODEX_ERROR_CODES.runtimeMissing }, ERROR_CATEGORIES.SPAWN_ERROR],
    ['a lost child process', { code: CODEX_ERROR_CODES.exited }, ERROR_CATEGORIES.SPAWN_ERROR],
    ['a request that never answered', { code: CODEX_ERROR_CODES.timeout }, ERROR_CATEGORIES.TIMEOUT],
    ['a revoked sign-in', { code: CODEX_ERROR_CODES.authRevoked }, ERROR_CATEGORIES.AUTH_ERROR],
    ['a cancelled turn', { code: CODEX_TURN_ERROR_CODES.turnInterrupted }, ERROR_CATEGORIES.CANCELED],
  ];

  it.each(cases)('maps %s onto the shared category vocabulary', (_label, error, expected) => {
    expect(classifyCodexTransportError(error)).toBe(expected);
  });

  it('falls back to the message when there is no structured tag', () => {
    expect(classifyCodexTransportError({ message: 'HTTP 401 unauthorized' })).toBe(ERROR_CATEGORIES.AUTH_ERROR);
    expect(classifyCodexTransportError({ message: 'something odd' })).toBe(ERROR_CATEGORIES.UNKNOWN);
  });

  it('classifies an oversized prompt as request-specific so it cannot bench the plan', () => {
    // 'context-length' is a SCHEMA_TYPE category — `isRequestSpecificCategory`
    // returns true for it, so the caller shrinks and retries instead of taking
    // the subscription offline for every other call.
    const acc = createTurnAccumulator({ threadId: 't', turnId: 'turn-1' });
    applyCodexTurnEvent(acc, CODEX_TURN_NOTIFICATIONS.turnCompleted, {
      threadId: 't',
      turn: { id: 'turn-1', status: 'failed', error: { message: 'too long', codexErrorInfo: 'contextWindowExceeded' } },
    });
    expect(finalizeCodexTurn(acc).category).toBe('context-length');
  });
});
