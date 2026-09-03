import { describe, it, expect } from 'vitest';
import {
  claudeProjectSlug,
  decodeGrokSessionDir,
  parseAgyHistory,
  parseAgyTranscript,
  parseClaudeTranscript,
  parseCodexRollout,
  parseGrokChatHistory,
  parseGrokTurns,
  totalTranscriptTokens,
  UNKNOWN_MODEL
} from './providerTranscriptUsage.js';

// Fixtures are hand-authored to match the real formats (verified against a live
// install) with invented paths/ids — never a transcribed real record, per the
// Sensitive Data rules in AGENTS.md.

const claudeLine = (overrides = {}) => JSON.stringify({
  type: 'assistant',
  uuid: overrides.uuid ?? 'uuid-1',
  sessionId: 'sess-abc',
  cwd: '/work/example-repo',
  timestamp: overrides.timestamp ?? '2026-07-01T10:00:00.000Z',
  requestId: overrides.requestId ?? 'req_1',
  message: {
    id: overrides.id ?? 'msg_1',
    model: overrides.model ?? 'claude-opus-5',
    role: 'assistant',
    usage: {
      input_tokens: overrides.input ?? 10,
      cache_creation_input_tokens: overrides.cacheWrite ?? 100,
      cache_read_input_tokens: overrides.cacheRead ?? 1000,
      output_tokens: overrides.output ?? 50,
      ...(overrides.usageExtras || {})
    }
  }
});

describe('claudeProjectSlug', () => {
  it('replaces slashes and dots the way the CLI names its project directory', () => {
    expect(claudeProjectSlug('/work/github.com/acme/Example'))
      .toBe('-work-github-com-acme-Example');
  });

  it('tolerates nullish input', () => {
    expect(claudeProjectSlug(null)).toBe('');
  });
});

describe('parseClaudeTranscript', () => {
  it('sums a complete session across every token tier', () => {
    const text = [
      claudeLine({ id: 'msg_1', uuid: 'u1' }),
      claudeLine({ id: 'msg_2', uuid: 'u2', input: 5, cacheWrite: 20, cacheRead: 500, output: 25 })
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(result).toMatchObject({
      sessionId: 'sess-abc',
      cwd: '/work/example-repo',
      model: 'claude-opus-5',
      messages: 2,
      tokensIn: 15,
      cacheWriteTokens: 120,
      cacheReadTokens: 1500,
      tokensOut: 75
    });
  });

  // The load-bearing behavior: the CLI writes one API response as SEVERAL lines
  // sharing a message.id and an identical usage block. Summing per line inflated
  // a measured session's counts ~2.3x.
  it('counts a response ONCE even when repeated across lines with the same message.id', () => {
    const text = [
      claudeLine({ id: 'msg_dup', uuid: 'u1' }),
      claudeLine({ id: 'msg_dup', uuid: 'u2' }),
      claudeLine({ id: 'msg_dup', uuid: 'u3' })
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(result.messages).toBe(1);
    expect(result.tokensOut).toBe(50);
    expect(result.cacheReadTokens).toBe(1000);
  });

  it('still counts a line with no message.id, keyed by its own uuid', () => {
    const noId = JSON.parse(claudeLine({ uuid: 'u9' }));
    delete noId.message.id;
    const text = [JSON.stringify(noId), JSON.stringify(noId)].join('\n');
    // Both lines carry the same uuid, so it is still one response.
    expect(parseClaudeTranscript(text).messages).toBe(1);
  });

  it('tolerates a truncated final line (session still being written)', () => {
    const text = `${claudeLine({ id: 'msg_1' })}\n{"type":"assistant","message":{"id":"msg_2","usa`;
    const result = parseClaudeTranscript(text);
    expect(result.messages).toBe(1);
    expect(result.tokensOut).toBe(50);
  });

  it('returns zeroes for a session with no assistant messages', () => {
    const text = [
      JSON.stringify({ type: 'user', sessionId: 'sess-abc', cwd: '/work/example-repo', message: { role: 'user' } }),
      JSON.stringify({ type: 'system', sessionId: 'sess-abc' })
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(result).toMatchObject({ messages: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // Session metadata is still recovered from non-assistant lines.
    expect(result.sessionId).toBe('sess-abc');
    expect(result.cwd).toBe('/work/example-repo');
    expect(totalTranscriptTokens(result)).toBe(0);
  });

  it('ignores unknown and extra fields', () => {
    const text = claudeLine({
      usageExtras: { server_tool_use: { web_search_requests: 2 }, service_tier: 'standard', brand_new_field: 7 }
    });
    const result = parseClaudeTranscript(text);
    expect(result.tokensOut).toBe(50);
    expect(result.messages).toBe(1);
  });

  it('windows by timestamp so one CLI session can split across two runs', () => {
    const text = [
      claudeLine({ id: 'early', timestamp: '2026-07-01T09:00:00.000Z' }),
      claudeLine({ id: 'late', timestamp: '2026-07-01T12:00:00.000Z' })
    ].join('\n');

    const windowed = parseClaudeTranscript(text, { from: Date.parse('2026-07-01T11:00:00.000Z') });
    expect(windowed.messages).toBe(1);
    expect(windowed.tokensOut).toBe(50);
  });

  it('reports every model seen and attributes the most-used one', () => {
    const text = [
      claudeLine({ id: 'a', model: 'claude-sonnet-5' }),
      claudeLine({ id: 'b', model: 'claude-opus-5' }),
      claudeLine({ id: 'c', model: 'claude-opus-5' })
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(result.model).toBe('claude-opus-5');
    expect(result.models.sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('ignores negative or non-numeric token values', () => {
    // Build the usage block directly — the fixture helper's `??` defaults would
    // swallow an explicit null before it reached the parser.
    const text = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5',
        usage: {
          input_tokens: -5,
          output_tokens: 'lots',
          cache_read_input_tokens: null,
          cache_creation_input_tokens: 10
        }
      }
    });
    const result = parseClaudeTranscript(text);
    expect(result).toMatchObject({ tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 10 });
  });
});

const codexMeta = (cwd = '/work/example-repo') => JSON.stringify({
  timestamp: '2026-07-01T10:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'rollout-abc', cwd, cli_version: '0.0.0', originator: 'codex_cli_rs', model: 'gpt-5.3-codex' }
});

const codexTokenCount = ({ timestamp, input, cached, output, reasoning = 0 }) => JSON.stringify({
  timestamp,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output
      },
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }
    }
  }
});

describe('parseCodexRollout', () => {
  // total_token_usage is CUMULATIVE and its events repeat verbatim — summing
  // either the totals or the per-turn `last` blocks over-counts badly.
  it('takes the final cumulative total rather than summing repeated events', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T10:00:01.000Z', input: 1000, cached: 800, output: 100 }),
      codexTokenCount({ timestamp: '2026-07-01T10:00:02.000Z', input: 1000, cached: 800, output: 100 }),
      codexTokenCount({ timestamp: '2026-07-01T10:00:03.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    const result = parseCodexRollout(text);
    // input_tokens INCLUDES the cached portion, so uncached input is 3000-2400.
    expect(result).toMatchObject({
      sessionId: 'rollout-abc',
      cwd: '/work/example-repo',
      model: 'gpt-5.3-codex',
      tokensIn: 600,
      cacheReadTokens: 2400,
      tokensOut: 250,
      cacheWriteTokens: 0
    });
  });

  it('windows by taking the delta from the last pre-window total', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T09:00:00.000Z', input: 1000, cached: 800, output: 100 }),
      codexTokenCount({ timestamp: '2026-07-01T12:00:00.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    // A rollout spanning two PortOS runs bills each only its own increment.
    const result = parseCodexRollout(text, { from: Date.parse('2026-07-01T11:00:00.000Z') });
    expect(result.tokensOut).toBe(150);          // 250 - 100
    expect(result.cacheReadTokens).toBe(1600);   // 2400 - 800
    expect(result.tokensIn).toBe(400);           // (3000-2400) - (1000-800)
  });

  it('tolerates a truncated final line', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T10:00:01.000Z', input: 1000, cached: 800, output: 100 }),
      '{"timestamp":"2026-07-01T10:00:02.000Z","type":"event_msg","payload":{"type":"token_c'
    ].join('\n');

    const result = parseCodexRollout(text);
    expect(result.tokensOut).toBe(100);
    expect(result.sessionId).toBe('rollout-abc');
  });

  it('returns zeroes for a rollout with no token_count events', () => {
    const result = parseCodexRollout(codexMeta());
    expect(result).toMatchObject({ messages: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 });
    // Metadata is still recovered so the caller can match on cwd.
    expect(result.cwd).toBe('/work/example-repo');
    expect(totalTranscriptTokens(result)).toBe(0);
  });

  it('ignores unknown line and payload types', () => {
    const text = [
      codexMeta(),
      JSON.stringify({ timestamp: '2026-07-01T10:00:01.000Z', type: 'brand_new_type', payload: { type: 'whatever', info: { total_token_usage: { input_tokens: 999999 } } } }),
      JSON.stringify({ timestamp: '2026-07-01T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }),
      codexTokenCount({ timestamp: '2026-07-01T10:00:03.000Z', input: 500, cached: 0, output: 20 })
    ].join('\n');

    const result = parseCodexRollout(text);
    expect(result.tokensIn).toBe(500);
    expect(result.tokensOut).toBe(20);
    expect(result.messages).toBe(1); // the one agent_message
  });

  it('handles an empty file', () => {
    expect(parseCodexRollout('')).toMatchObject({ sessionId: null, tokensIn: 0, tokensOut: 0 });
  });

  it('never returns a negative delta when a total appears to regress', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T09:00:00.000Z', input: 5000, cached: 4000, output: 500 }),
      codexTokenCount({ timestamp: '2026-07-01T12:00:00.000Z', input: 1000, cached: 800, output: 100 })
    ].join('\n');

    const result = parseCodexRollout(text, { from: Date.parse('2026-07-01T11:00:00.000Z') });
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
  });
});

describe('totalTranscriptTokens', () => {
  it('sums every billable bucket', () => {
    expect(totalTranscriptTokens({ tokensIn: 1, tokensOut: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe(10);
  });

  it('treats missing buckets as zero', () => {
    expect(totalTranscriptTokens({})).toBe(0);
    expect(totalTranscriptTokens(null)).toBe(0);
  });
});

describe('windowing excludes un-placeable messages', () => {
  // A line with no readable timestamp can't be placed in any run. Accepting it
  // under a bounded window would hand the same tokens to EVERY run that reads
  // the file — one unparseable line becoming permanent double-billing.
  it('excludes a timestamp-less Claude message when a window is supplied', () => {
    const noTs = JSON.parse(claudeLine({ id: 'no-ts' }));
    delete noTs.timestamp;
    const text = [
      JSON.stringify(noTs),
      claudeLine({ id: 'in-window', timestamp: '2026-07-01T10:05:00.000Z' })
    ].join('\n');

    const windowed = parseClaudeTranscript(text, {
      from: Date.parse('2026-07-01T10:00:00.000Z'),
      to: Date.parse('2026-07-01T10:10:00.000Z')
    });
    expect(windowed.messages).toBe(1);
    expect(windowed.tokensOut).toBe(50);
  });

  it('still counts a timestamp-less message on an UNBOUNDED read', () => {
    const noTs = JSON.parse(claudeLine({ id: 'no-ts' }));
    delete noTs.timestamp;
    // No window means no other run to double-count against, so keeping it is
    // strictly better than dropping real tokens.
    expect(parseClaudeTranscript(JSON.stringify(noTs)).messages).toBe(1);
  });

  it('windows Codex agent_message counts alongside the token delta', () => {
    const text = [
      codexMeta(),
      JSON.stringify({ timestamp: '2026-07-01T09:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'earlier run' } }),
      codexTokenCount({ timestamp: '2026-07-01T09:00:01.000Z', input: 1000, cached: 800, output: 100 }),
      JSON.stringify({ timestamp: '2026-07-01T12:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'this run' } }),
      codexTokenCount({ timestamp: '2026-07-01T12:00:01.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    // The later run's tokens are a delta, so its message count must be too —
    // otherwise it also claims the earlier run's messages.
    const result = parseCodexRollout(text, { from: Date.parse('2026-07-01T11:00:00.000Z') });
    expect(result.messages).toBe(1);
    expect(result.tokensOut).toBe(150);
  });

  it('excludes a timestamp-less Codex token_count snapshot when a window is supplied', () => {
    const text = [
      codexMeta(),
      // In-window snapshot this run should bill.
      codexTokenCount({ timestamp: '2026-07-01T12:00:01.000Z', input: 1000, cached: 800, output: 100 }),
      // A later snapshot with NO timestamp — outside this run's window in
      // reality, but unplaceable. Falling through to `latest` (the bug) would
      // fold its bigger cumulative total into this run instead of the run
      // that actually produced it.
      codexTokenCount({ timestamp: undefined, input: 9000, cached: 8000, output: 900 })
    ].join('\n');

    const result = parseCodexRollout(text, {
      from: Date.parse('2026-07-01T11:00:00.000Z'),
      to: Date.parse('2026-07-01T13:00:00.000Z')
    });
    expect(result.tokensOut).toBe(100);
  });
});

describe('per-model token buckets', () => {
  it('splits a model switch into per-model buckets that sum to the totals', () => {
    const text = [
      claudeLine({ id: 'a', model: 'claude-opus-5', output: 50, cacheRead: 1000, input: 10, cacheWrite: 100 }),
      claudeLine({ id: 'b', model: 'claude-haiku-4-5', output: 25, cacheRead: 500, input: 5, cacheWrite: 20 })
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(Object.keys(result.byModel).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5']);
    expect(result.byModel['claude-opus-5']).toMatchObject({ messages: 1, tokensOut: 50, cacheReadTokens: 1000, cacheWriteTokens: 100 });
    expect(result.byModel['claude-haiku-4-5']).toMatchObject({ messages: 1, tokensOut: 25, cacheReadTokens: 500, cacheWriteTokens: 20 });
    // No tokens invented or lost by the split.
    const sum = (field) => Object.values(result.byModel).reduce((s, b) => s + b[field], 0);
    expect(sum('tokensOut')).toBe(result.tokensOut);
    expect(sum('tokensIn')).toBe(result.tokensIn);
    expect(sum('cacheReadTokens')).toBe(result.cacheReadTokens);
    expect(sum('cacheWriteTokens')).toBe(result.cacheWriteTokens);
  });

  it('mirrors the Codex rollout total into byModel for shape parity', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T10:00:01.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    const result = parseCodexRollout(text);
    expect(result.byModel['gpt-5.3-codex']).toMatchObject({
      tokensIn: 600, cacheReadTokens: 2400, tokensOut: 250, cacheWriteTokens: 0
    });
  });
});

describe('no billable tokens are dropped from byModel', () => {
  // Callers price from `byModel`, so a billable message whose line carries no
  // `message.model` must still get a bucket — otherwise its tokens vanish from
  // the recorded total (measured: 500 output tokens lost on a 2-message file).
  it('buckets a model-less message under UNKNOWN_MODEL', () => {
    const noModel = JSON.parse(claudeLine({ id: 'm2', output: 500, cacheRead: 2000, input: 5, cacheWrite: 0 }));
    delete noModel.message.model;
    const text = [
      claudeLine({ id: 'm1', model: 'claude-opus-5', output: 100, cacheRead: 1000, input: 10, cacheWrite: 0 }),
      JSON.stringify(noModel)
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(result.byModel[UNKNOWN_MODEL]).toMatchObject({ tokensOut: 500, cacheReadTokens: 2000 });
    // byModel must account for the whole aggregate — nothing dropped.
    const sum = (f) => Object.values(result.byModel).reduce((s, b) => s + b[f], 0);
    expect(sum('tokensOut')).toBe(result.tokensOut);
    expect(sum('tokensIn')).toBe(result.tokensIn);
    expect(sum('cacheReadTokens')).toBe(result.cacheReadTokens);
    expect(sum('messages')).toBe(result.messages);
  });

  // A Codex rollout whose session_meta/turn_context never named a model used
  // to return byModel: {} despite nonzero totals — invisible to
  // reconcileRunUsage's per-model billing path once a NAMED-model rollout
  // shared the same run window, silently dropping this rollout's tokens.
  it('buckets a model-less Codex rollout under UNKNOWN_MODEL instead of an empty byModel', () => {
    const metaNoModel = JSON.stringify({
      timestamp: '2026-07-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'rollout-no-model', cwd: '/work/example-repo', cli_version: '0.0.0' }
    });
    const text = [
      metaNoModel,
      codexTokenCount({ timestamp: '2026-07-01T10:00:01.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    const result = parseCodexRollout(text);
    expect(result.model).toBeNull();
    expect(Object.keys(result.byModel)).toEqual([UNKNOWN_MODEL]);
    expect(result.byModel[UNKNOWN_MODEL]).toMatchObject({ tokensOut: 250, cacheReadTokens: 2400 });
  });
});

describe('Codex message count under a window', () => {
  // Synthesizing a message for a bounded read would inflate every later
  // overlapping run's message total.
  it('keeps zero when the window contains a token delta but no agent_message', () => {
    const text = [
      codexMeta(),
      JSON.stringify({ timestamp: '2026-07-01T09:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'before the window' } }),
      codexTokenCount({ timestamp: '2026-07-01T09:00:01.000Z', input: 1000, cached: 800, output: 100 }),
      codexTokenCount({ timestamp: '2026-07-01T12:00:00.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    const result = parseCodexRollout(text, { from: Date.parse('2026-07-01T11:00:00.000Z') });
    expect(result.messages).toBe(0);
    expect(result.tokensOut).toBe(150); // the delta is still billed
  });

  it('still synthesizes one on an unbounded read that produced tokens', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T10:00:01.000Z', input: 1000, cached: 0, output: 60 })
    ].join('\n');
    expect(parseCodexRollout(text).messages).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Grok — ~/.grok/sessions/<encodeURIComponent(cwd)>/<session-id>/
// ---------------------------------------------------------------------------

const GROK_MODEL = 'example-grok-model';

/** One `updates.jsonl` envelope carrying a completed turn. */
const grokTurn = ({
  promptId = 'prompt-1',
  seconds = 1_800_000_000,
  input = 15_000,
  output = 1_800,
  cachedRead = 11_000,
  cacheCreation = 0,
  reasoning = 800,
  model = GROK_MODEL,
  ms = null
} = {}) => JSON.stringify({
  timestamp: seconds,
  method: '_x.ai/session/update',
  params: {
    sessionId: 'session-aaaa',
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: promptId,
      stop_reason: 'end_turn',
      usage: {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        cachedReadTokens: cachedRead,
        cacheCreationTokens: cacheCreation,
        reasoningTokens: reasoning,
        modelUsage: { [model]: { inputTokens: input, outputTokens: output } }
      }
    },
    ...(ms == null ? {} : { _meta: { eventId: 'evt-1', agentTimestampMs: ms } })
  }
});

/** A streaming chunk carrying CONTEXT-WINDOW OCCUPANCY, which is never billed. */
const grokChunk = (totalTokens) => JSON.stringify({
  timestamp: 1_800_000_000,
  method: '_x.ai/session/update',
  params: {
    sessionId: 'session-aaaa',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    _meta: { totalTokens }
  }
});

describe('parseGrokTurns', () => {
  it('bills a completed turn with the cache tier split out of input', () => {
    const parsed = parseGrokTurns(grokTurn());
    // `inputTokens` INCLUDES `cachedReadTokens`, so the fresh input is the
    // difference; billing both whole would charge cache reads at full rate.
    expect(parsed.tokensIn).toBe(4_000);
    expect(parsed.cacheReadTokens).toBe(11_000);
    // `reasoningTokens` is a SUBSET of `outputTokens`, never an addition.
    expect(parsed.tokensOut).toBe(1_800);
    expect(parsed.cacheWriteTokens).toBe(0);
    expect(parsed.byModel[GROK_MODEL].tokensOut).toBe(1_800);
    expect(parsed.model).toBe(GROK_MODEL);
    expect(parsed.sessionId).toBe('session-aaaa');
  });

  it('never bills the _meta.totalTokens context-window occupancy', () => {
    const parsed = parseGrokTurns([grokChunk(950_000), grokChunk(1_200_000)].join('\n'));
    expect(totalTranscriptTokens(parsed)).toBe(0);
    // Sentinel: no turn was recorded at all, so the caller falls back to chat
    // history rather than reporting a measured zero.
    expect(parsed.turns).toBe(0);
  });

  it('sums per-prompt turns without treating them as cumulative', () => {
    const text = [
      grokTurn({ promptId: 'p1', input: 10_000, cachedRead: 6_000, output: 500 }),
      grokTurn({ promptId: 'p2', input: 4_000, cachedRead: 1_000, output: 100 })
    ].join('\n');
    const parsed = parseGrokTurns(text);
    expect(parsed.tokensIn).toBe(4_000 + 3_000);
    expect(parsed.tokensOut).toBe(600);
    expect(parsed.countedKeys).toEqual(['p1', 'p2']);
  });

  it('converts a cumulative-for-the-session stream to per-turn deltas', () => {
    // Every field non-decreasing across three or more turns is the cumulative
    // signature. Summing the raw snapshots here would bill 60k input for a
    // session that really used 30k — the #5831 double-count hazard.
    const text = [
      grokTurn({ promptId: 'p1', input: 10_000, cachedRead: 5_000, output: 100 }),
      grokTurn({ promptId: 'p2', input: 20_000, cachedRead: 9_000, output: 300 }),
      grokTurn({ promptId: 'p3', input: 30_000, cachedRead: 12_000, output: 400 })
    ].join('\n');
    const parsed = parseGrokTurns(text);
    expect(parsed.tokensIn).toBe(30_000 - 12_000);
    expect(parsed.tokensOut).toBe(400);
    expect(parsed.cacheReadTokens).toBe(12_000);
  });

  it('windows turns by the epoch-seconds envelope timestamp', () => {
    const text = [
      grokTurn({ promptId: 'p1', seconds: 1_800_000_000, output: 111 }),
      grokTurn({ promptId: 'p2', seconds: 1_800_003_600, output: 222 })
    ].join('\n');
    const parsed = parseGrokTurns(text, { from: 1_800_003_000_000, to: 1_800_004_000_000 });
    expect(parsed.tokensOut).toBe(222);
    expect(parsed.countedKeys).toEqual(['p2']);
  });

  it('prefers the millisecond _meta timestamp when present', () => {
    // A 10-digit envelope `timestamp` is SECONDS; read as ms it lands in 1970
    // and every window check fails.
    const text = grokTurn({ promptId: 'p1', seconds: 1_800_000_000, ms: 1_800_000_000_500, output: 42 });
    expect(parseGrokTurns(text, { from: 1_800_000_000_000, to: 1_800_000_001_000 }).tokensOut).toBe(42);
  });

  it('skips turns another run already claimed', () => {
    const text = [
      grokTurn({ promptId: 'p1', output: 111 }),
      grokTurn({ promptId: 'p2', output: 222 })
    ].join('\n');
    const parsed = parseGrokTurns(text, { exclude: new Set(['p1']) });
    expect(parsed.tokensOut).toBe(222);
    expect(parsed.countedKeys).toEqual(['p2']);
  });

  it('tolerates a truncated trailing line from a session still being written', () => {
    const text = `${grokTurn({ promptId: 'p1', output: 111 })}\n{"timestamp":18000000`;
    expect(parseGrokTurns(text).tokensOut).toBe(111);
  });
});

describe('parseGrokChatHistory', () => {
  it('splits chars by role for the no-completed-turn fallback', () => {
    const text = [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'a'.repeat(40) }] }),
      JSON.stringify({ type: 'assistant', content: 'b'.repeat(20), model_id: GROK_MODEL, tool_calls: [{ id: 't1', name: 'read', arguments: 'c'.repeat(8) }] }),
      JSON.stringify({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'd'.repeat(12) }], encrypted_content: 'e'.repeat(5000) }),
      JSON.stringify({ type: 'tool_result', tool_call_id: 't1', content: 'f'.repeat(60) })
    ].join('\n');
    const parsed = parseGrokChatHistory(text);
    expect(parsed.charsIn).toBe(100);
    // `encrypted_content` is an opaque blob, not text — its 5000 chars say
    // nothing about the tokens it stands for and must not inflate the estimate.
    expect(parsed.charsOut).toBe(40);
    expect(parsed.model).toBe(GROK_MODEL);
    expect(parsed.messages).toBe(1);
  });
});

describe('decodeGrokSessionDir', () => {
  it('round-trips an encodeURIComponent-ed workspace path', () => {
    const cwd = '/tmp/example-workspace/sub dir';
    expect(decodeGrokSessionDir(encodeURIComponent(cwd))).toBe(cwd);
  });

  it('returns null for a folder name that is not valid percent-encoding', () => {
    expect(decodeGrokSessionDir('%zz-not-encoded')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Antigravity — ~/.gemini/antigravity-cli/
// ---------------------------------------------------------------------------

const agyStep = ({ index = 0, type = 'GENERIC', createdAt = '2026-07-01T10:00:00Z', content = '', thinking = null, toolCalls = null }) => JSON.stringify({
  step_index: index,
  source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL',
  type,
  status: 'DONE',
  created_at: createdAt,
  ...(content ? { content } : {}),
  ...(thinking ? { thinking } : {}),
  ...(toolCalls ? { tool_calls: toolCalls } : {})
});

describe('parseAgyTranscript', () => {
  it('counts PLANNER_RESPONSE as output and every other step as input', () => {
    const text = [
      agyStep({ index: 0, type: 'USER_INPUT', content: 'u'.repeat(40) }),
      agyStep({ index: 1, type: 'PLANNER_RESPONSE', content: 'p'.repeat(10), thinking: 't'.repeat(6), toolCalls: [{ name: 'ls', args: { path: '/tmp/example-workspace' } }] }),
      // A tool RESULT carries `source: 'MODEL'` but the text is the tool's, and
      // it is what the model reads next — so the split keys off `type`.
      agyStep({ index: 2, type: 'VIEW_FILE', content: 'v'.repeat(100) })
    ].join('\n');
    const parsed = parseAgyTranscript(text);
    expect(parsed.charsIn).toBe(140);
    expect(parsed.charsOut).toBe(16 + JSON.stringify({ path: '/tmp/example-workspace' }).length);
    expect(parsed.messages).toBe(1);
    expect(parsed.countedKeys).toEqual(['step-0', 'step-1', 'step-2']);
  });

  it('windows steps by created_at and reports how many it saw', () => {
    const text = [
      agyStep({ index: 0, type: 'GENERIC', createdAt: '2026-07-01T09:00:00Z', content: 'a'.repeat(80) }),
      agyStep({ index: 1, type: 'GENERIC', createdAt: '2026-07-01T10:00:00Z', content: 'b'.repeat(40) })
    ].join('\n');
    const parsed = parseAgyTranscript(text, {
      from: Date.parse('2026-07-01T09:30:00Z'),
      to: Date.parse('2026-07-01T10:30:00Z')
    });
    expect(parsed.charsIn).toBe(40);
    // Sentinel: two steps were READ, this window's share is one of them —
    // distinct from an unreadable transcript, which yields no result at all.
    expect(parsed.steps).toBe(2);
    expect(parsed.countedKeys).toEqual(['step-1']);
  });

  it('skips steps another run already claimed', () => {
    const text = [
      agyStep({ index: 0, content: 'a'.repeat(80) }),
      agyStep({ index: 1, content: 'b'.repeat(40) })
    ].join('\n');
    expect(parseAgyTranscript(text, { exclude: new Set(['step-0']) }).charsIn).toBe(40);
  });
});

describe('parseAgyHistory', () => {
  it('keeps only the lines that name a conversation, once each', () => {
    const text = [
      JSON.stringify({ display: '/status', timestamp: 1_800_000_000_000, type: 'slash_command', workspace: '/tmp/example-workspace' }),
      JSON.stringify({ display: 'do the thing', timestamp: 1_800_000_001_000, workspace: '/tmp/example-workspace', conversationId: 'conv-aaaa' }),
      JSON.stringify({ display: 'again', timestamp: 1_800_000_002_000, workspace: '/tmp/example-workspace', conversationId: 'conv-aaaa' })
    ].join('\n');
    expect(parseAgyHistory(text)).toEqual([
      { conversationId: 'conv-aaaa', workspace: '/tmp/example-workspace', timestamp: 1_800_000_001_000 }
    ]);
  });
});
