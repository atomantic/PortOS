import { describe, it, expect, vi } from 'vitest';

// #5907 — the confirmation-gate REPLAY path (a user's "yes"/"confirm" turn
// resolving a `state.pendingDestructive` record stashed by a prior turn).
// Generalized from a hardcoded `voice:ui:click` emission to replay whichever
// tool actually stashed the record (ui_click / ui_check / ui_fill), because a
// ui_fill or ui_check confirmation must not be replayed as a click.
// `pipelineConfirmShortCircuit.test.js` covers the STASH half (a tool
// returning confirmation_required stops the turn); this file covers the
// RESOLVE half (the next turn's "yes"/"cancel").

vi.mock('./config.js', () => ({
  getVoiceConfig: vi.fn(async () => ({
    enabled: true,
    llm: {
      model: 'test-model',
      usePersonality: false,
      systemPrompt: 'sys',
      tools: { enabled: true, maxIterations: 3 },
    },
  })),
}));

const transcribeMock = vi.fn(async () => ({ text: 'confirm', latencyMs: 5 }));
vi.mock('./stt.js', () => ({
  transcribe: (...args) => transcribeMock(...args),
}));

vi.mock('./tts.js', () => ({
  synthesize: vi.fn(async (text) => ({ wav: Buffer.alloc(8), latencyMs: 1, _text: text })),
}));

const streamChatMock = vi.fn();
vi.mock('./llm.js', () => ({
  streamChat: (...args) => streamChatMock(...args),
}));

const dispatchToolMock = vi.fn();
vi.mock('./tools.js', () => ({
  getToolSpecsForIntent: () => ({ specs: [], activeGroups: new Set() }),
  classifyIntent: () => new Set(),
  dispatchTool: (...args) => dispatchToolMock(...args),
  getAllToolNames: () => ['ui_click', 'ui_check', 'ui_fill'],
  UI_KINDS: ['tab', 'button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio'],
}));

vi.mock('./echo.js', () => ({
  isEchoOfRecentTts: () => false,
  rememberTtsSentence: () => {},
}));

vi.mock('../brainJournal.js', () => ({
  appendJournal: vi.fn(),
  getToday: vi.fn(async () => '2026-05-12'),
}));

const { runTurn } = await import('./pipeline.js');
const { buildPending } = await import('./confirmGate.js');

async function runWithPending(pending, utterance = 'confirm') {
  transcribeMock.mockResolvedValueOnce({ text: utterance, latencyMs: 5 });
  const events = [];
  const emit = (event, payload) => events.push({ event, payload });
  const state = { pendingDestructive: pending };
  const result = await runTurn({
    audio: Buffer.alloc(8),
    mimeType: 'audio/webm',
    history: [],
    emit,
    state,
  });
  return { events, result, state };
}

describe('runTurn — confirmation-gate replay dispatches by pending.tool (#5907)', () => {
  it('replays a pending ui_click as voice:ui:click', async () => {
    const pending = buildPending({
      tool: 'ui_click',
      args: { label: 'Send', kind: 'button' },
      target: { ref: 1, label: 'Send', kind: 'button' },
    });
    const { events, state } = await runWithPending(pending);

    const click = events.find((e) => e.event === 'voice:ui:click');
    expect(click).toBeTruthy();
    expect(click.payload).toEqual({ target: { label: 'Send' } });
    expect(events.some((e) => e.event === 'voice:ui:fill')).toBe(false);
    expect(events.some((e) => e.event === 'voice:ui:check')).toBe(false);
    // Consumed up front regardless of branch outcome.
    expect(state.pendingDestructive).toBeNull();
  });

  it('replays a pending ui_fill as voice:ui:fill, not a click', async () => {
    const pending = buildPending({
      tool: 'ui_fill',
      args: { label: 'Additional context for the agent', value: 'stop what you are doing' },
      target: { ref: 8, label: 'Additional context for the agent', kind: 'input' },
    });
    const { events } = await runWithPending(pending);

    const fill = events.find((e) => e.event === 'voice:ui:fill');
    expect(fill).toBeTruthy();
    expect(fill.payload).toEqual({
      target: { label: 'Additional context for the agent' },
      value: 'stop what you are doing',
    });
    expect(events.some((e) => e.event === 'voice:ui:click')).toBe(false);
  });

  it('replays a pending ui_check as voice:ui:check, not a click', async () => {
    const pending = buildPending({
      tool: 'ui_check',
      args: { label: 'Auto-publish', checked: true },
      target: { ref: 6, label: 'Auto-publish', kind: 'checkbox' },
    });
    const { events } = await runWithPending(pending);

    const check = events.find((e) => e.event === 'voice:ui:check');
    expect(check).toBeTruthy();
    expect(check.payload).toEqual({ target: { label: 'Auto-publish' }, checked: true });
    expect(events.some((e) => e.event === 'voice:ui:click')).toBe(false);
  });

  it('cancels a pending ui_fill without emitting any voice:ui:* event', async () => {
    const pending = buildPending({
      tool: 'ui_fill',
      args: { label: 'Additional context for the agent', value: 'x' },
      target: { ref: 8, label: 'Additional context for the agent', kind: 'input' },
    });
    const { events, result } = await runWithPending(pending, 'cancel');

    expect(events.some((e) => e.event?.startsWith('voice:ui:'))).toBe(false);
    expect(result.reply).toBe('Cancelled.');
  });
});
