import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The wiring test exercises the REAL event emitters (they're module
// singletons) but injects a fake `speak`, so no tts/timezone mocking is needed
// — the delivery primitive never runs. Only `getVoiceConfig` is overridden
// (the agent:completed handler reads it for the announceOnComplete gate);
// the rest of config.js (voiceHome, PIPER_BIN_NAME) must stay real because
// the proactiveSpeech → tts import chain reads those at module load.
vi.mock('./config.js', async (importActual) => ({
  ...(await importActual()),
  getVoiceConfig: vi.fn(async () => ({ enabled: true, llm: { codeAgent: { announceOnComplete: true } } })),
}));

import { errorEvents } from '../../lib/errorHandler.js';
import { cosEvents } from '../cosEvents.js';
import { notificationEvents } from '../notifications.js';
import { getVoiceConfig } from './config.js';
import {
  allowBySource,
  isHighPriorityNotification,
  formatErrorLine,
  formatTaskLine,
  formatNotificationLine,
  formatTaskCompletionLine,
  deriveTaskSpeechLabel,
  wireProactiveTriggers,
  RATE_LIMIT_MS,
} from './proactiveTriggers.js';

// The swarm block a scheduled claim-issue task's description leads with — the
// exact scaffolding the voice agent used to recite verbatim.
const SWARM_DESCRIPTION = `# ⚡ SWARM MODE — claim and ship up to 3 independent issues in parallel

**This run operates in slashdo \`/do:next --swarm=3\` mode.** The single-issue framing in the task body below is your PER-AGENT playbook, not the shape of the whole run.`;

// Let the fire-and-forget dispatch promise chain settle after a synchronous
// emit before asserting.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('allowBySource', () => {
  it('allows the first line for a known source (no prior timestamp)', () => {
    expect(allowBySource('error', null, 1000)).toBe(true);
    expect(allowBySource('error', undefined, 1000)).toBe(true);
  });

  it('throttles within the per-source window and allows past it', () => {
    const limits = { error: 1000 };
    expect(allowBySource('error', 5000, 5500, limits)).toBe(false);
    expect(allowBySource('error', 5000, 6000, limits)).toBe(true);
    expect(allowBySource('error', 5000, 6500, limits)).toBe(true);
  });

  it('never throttles an unknown source', () => {
    expect(allowBySource('mystery', 5000, 5001)).toBe(true);
  });
});

describe('isHighPriorityNotification', () => {
  it('passes high and critical only', () => {
    expect(isHighPriorityNotification('high')).toBe(true);
    expect(isHighPriorityNotification('critical')).toBe(true);
    expect(isHighPriorityNotification('medium')).toBe(false);
    expect(isHighPriorityNotification('low')).toBe(false);
    expect(isHighPriorityNotification(undefined)).toBe(false);
  });
});

describe('formatErrorLine', () => {
  it('speaks only critical errors', () => {
    expect(formatErrorLine({ severity: 'critical', message: 'DB down' })).toMatch(/critical error.*DB down/i);
    expect(formatErrorLine({ severity: 'error', message: 'minor' })).toBe('');
    expect(formatErrorLine({ severity: 'warning', message: 'meh' })).toBe('');
  });

  it('returns empty when a critical error has no message', () => {
    expect(formatErrorLine({ severity: 'critical', message: '' })).toBe('');
  });

  it('clips very long messages', () => {
    const long = 'x'.repeat(500);
    const line = formatErrorLine({ severity: 'critical', message: long });
    expect(line.length).toBeLessThan(300);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('formatTaskLine', () => {
  it('prefers title, falls back to description', () => {
    expect(formatTaskLine({ title: 'Ship it' })).toBe('A new task is ready: Ship it.');
    expect(formatTaskLine({ description: 'Fix the bug' })).toBe('A new task is ready: Fix the bug.');
  });

  it('speaks the swarm topic, not the raw prompt block', () => {
    expect(formatTaskLine({ description: SWARM_DESCRIPTION }))
      .toBe('A new task is ready: claim and ship up to 3 independent issues in parallel.');
  });

  it('returns empty when neither title nor description present', () => {
    expect(formatTaskLine({})).toBe('');
    expect(formatTaskLine(null)).toBe('');
  });
});

describe('deriveTaskSpeechLabel', () => {
  it('strips the swarm block down to its topic', () => {
    expect(deriveTaskSpeechLabel({ description: SWARM_DESCRIPTION }))
      .toBe('claim and ship up to 3 independent issues in parallel');
  });

  it('strips a leading [Tag: App] label from a claim/plan prompt', () => {
    expect(deriveTaskSpeechLabel({
      description: '[Claim Issue: PortOS] Claim and ship the next open GitHub issue\n\nPhase 1 …',
    })).toBe('Claim and ship the next open GitHub issue');
  });

  it('prefers an explicit title, then a post-run agent summary', () => {
    expect(deriveTaskSpeechLabel({ title: 'Ship it', description: SWARM_DESCRIPTION })).toBe('Ship it');
    expect(deriveTaskSpeechLabel({
      description: SWARM_DESCRIPTION,
      metadata: { taskSummary: 'Fixed the flaky backup test' },
    })).toBe('Fixed the flaky backup test');
  });

  it('falls through a blank title to a real post-run summary', () => {
    expect(deriveTaskSpeechLabel({
      title: '   ',
      metadata: { taskSummary: 'Fixed the flaky backup test' },
      description: SWARM_DESCRIPTION,
    })).toBe('Fixed the flaky backup test');
  });

  it('skips scaffolding-only leading lines to the first real topic', () => {
    expect(deriveTaskSpeechLabel({ description: '#\n---\nRefactor the widget registry' }))
      .toBe('Refactor the widget registry');
  });

  it('returns empty for a missing or empty task', () => {
    expect(deriveTaskSpeechLabel(null)).toBe('');
    expect(deriveTaskSpeechLabel({})).toBe('');
    expect(deriveTaskSpeechLabel({ description: '' })).toBe('');
  });
});

describe('formatNotificationLine', () => {
  it('speaks high-priority notifications, appending description when present', () => {
    expect(formatNotificationLine({ priority: 'high', title: 'Backup failed' })).toBe('Backup failed');
    expect(formatNotificationLine({ priority: 'critical', title: 'Disk full', description: 'Act now' }))
      .toBe('Disk full. Act now');
  });

  it('skips low/medium priority and title-less notifications', () => {
    expect(formatNotificationLine({ priority: 'medium', title: 'meh' })).toBe('');
    expect(formatNotificationLine({ priority: 'high', title: '' })).toBe('');
  });
});

describe('formatTaskCompletionLine', () => {
  it('reports success with the first line of the task description', () => {
    const line = formatTaskCompletionLine({
      status: 'completed',
      description: 'Fix the flaky backup test\n\nmore detail here',
    });
    expect(line).toBe('Your coding task is done: Fix the flaky backup test.');
  });

  it('announces the swarm topic on completion, not the prompt block', () => {
    expect(formatTaskCompletionLine({ status: 'completed', description: SWARM_DESCRIPTION }))
      .toBe('Your coding task is done: claim and ship up to 3 independent issues in parallel.');
  });

  it('reports a blocked task as a failure', () => {
    const line = formatTaskCompletionLine({ status: 'blocked', description: 'Refactor the registry' });
    expect(line).toMatch(/didn't finish cleanly/i);
    expect(line).toMatch(/Refactor the registry/);
  });

  it('falls back to a generic line when no description is present', () => {
    expect(formatTaskCompletionLine({ status: 'completed', description: '' }))
      .toBe('Your coding task is done.');
    expect(formatTaskCompletionLine(null)).toBe('');
  });
});

describe('wireProactiveTriggers', () => {
  let unwire;
  let speak;

  beforeEach(() => {
    speak = vi.fn(async () => ({ ok: true }));
    getVoiceConfig.mockResolvedValue({ enabled: true, llm: { codeAgent: { announceOnComplete: true } } });
  });

  afterEach(() => {
    if (unwire) unwire();
    unwire = null;
    vi.restoreAllMocks();
  });

  it('returns a no-op and warns when io is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off = wireProactiveTriggers({ io: null, speak });
    off(); // must not throw
    expect(warn).toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });

  it('speaks on a critical error but not a routine one', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });

    errorEvents.emit('error', { severity: 'error', message: 'routine 500' });
    await flush();
    expect(speak).not.toHaveBeenCalled();

    errorEvents.emit('error', { severity: 'critical', message: 'meltdown' });
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toMatchObject({ source: 'error', priority: 'high' });
    expect(speak.mock.calls[0][0].text).toMatch(/meltdown/);
  });

  it('speaks on task:ready and high-priority notifications', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });

    cosEvents.emit('task:ready', { title: 'Render scene 3' });
    notificationEvents.emit('added', { priority: 'high', title: 'Sync complete' });
    notificationEvents.emit('added', { priority: 'low', title: 'ignored' });
    await flush();

    const sources = speak.mock.calls.map((c) => c[0].source).sort();
    expect(sources).toEqual(['notification', 'task:ready']);
  });

  it('rate-limits a burst from one source to a single line', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak, limits: { error: 60_000 } });

    errorEvents.emit('error', { severity: 'critical', message: 'first' });
    await flush();
    errorEvents.emit('error', { severity: 'critical', message: 'second' });
    await flush();

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].text).toMatch(/first/);
  });

  it('rate-limits a same-tick concurrent burst (slot reserved before await)', async () => {
    // Synthesis is async; emit two same-source events on the SAME tick (no
    // flush between) so the second fires while the first speak() is still
    // pending. The pre-await reservation must block the second — otherwise
    // both start concurrent syntheses and talk over each other.
    let resolveSpeak;
    speak = vi.fn(() => new Promise((r) => { resolveSpeak = () => r({ ok: true }); }));
    unwire = wireProactiveTriggers({ io: {}, speak, limits: { error: 60_000 } });

    errorEvents.emit('error', { severity: 'critical', message: 'first' });
    errorEvents.emit('error', { severity: 'critical', message: 'second' });
    resolveSpeak();
    await flush();

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].text).toMatch(/first/);
  });

  it('does not advance the bucket when a line was suppressed (ok:false)', async () => {
    speak = vi.fn(async () => ({ ok: false, reason: 'quiet-hours' }));
    unwire = wireProactiveTriggers({ io: {}, speak, limits: { error: 60_000 } });

    errorEvents.emit('error', { severity: 'critical', message: 'first' });
    await flush();
    errorEvents.emit('error', { severity: 'critical', message: 'second' });
    await flush();

    // Both attempts reach speak because the first never went out.
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('does not leak an unhandled rejection when speak rejects', async () => {
    speak = vi.fn(async () => { throw new Error('synthesis exploded'); });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    let unhandled = null;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);

    // try/finally so a failed assertion can't leak the process-level listener
    // into later tests (cross-test flakiness).
    try {
      unwire = wireProactiveTriggers({ io: {}, speak, limits: { error: 60_000 } });
      errorEvents.emit('error', { severity: 'critical', message: 'boom' });

      // Give the rejected promise time to surface as an unhandled rejection
      // if the guard ever regresses.
      await new Promise((r) => setTimeout(r, 50));

      expect(unhandled).toBeNull(); // load-bearing: locks in the no-leak guard
      expect(errorLog).toHaveBeenCalled();

      // Bucket did not advance — a later critical can still try.
      errorEvents.emit('error', { severity: 'critical', message: 'again' });
      await flush();
      expect(speak).toHaveBeenCalledTimes(2);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rate-limits the throttled sources but NOT solicited task completions', () => {
    expect(RATE_LIMIT_MS).toHaveProperty('error');
    expect(RATE_LIMIT_MS).toHaveProperty('task:ready');
    expect(RATE_LIMIT_MS).toHaveProperty('notification');
    // Solicited completions are serialized (queued), not drop-throttled.
    expect(RATE_LIMIT_MS).not.toHaveProperty('task-complete');
  });

  it('announces BOTH of two back-to-back completions (no drop-based throttle)', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });
    const upd = (id) => ({ type: 'user', action: 'updated', task: { id, status: 'completed', description: `task ${id}`, metadata: { voiceDispatch: true } } });
    cosEvents.emit('tasks:changed', upd('a'));
    cosEvents.emit('tasks:changed', upd('b'));
    await flush();
    await flush();
    expect(speak).toHaveBeenCalledTimes(2);
    const spoken = speak.mock.calls.map((c) => c[0].text).join(' | ');
    expect(spoken).toMatch(/task a/);
    expect(spoken).toMatch(/task b/);
  });

  // Helper: a tasks:changed 'updated' event payload for a voice-dispatched task.
  const taskUpdate = (status, extra = {}) => ({
    type: 'user',
    action: 'updated',
    task: { id: 't1', status, description: 'Fix the backup test', metadata: { voiceDispatch: true, ...extra } },
  });

  it('announces a voice-dispatched task completion as a solicited line', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });

    // A non-voice task completing must NOT speak.
    cosEvents.emit('tasks:changed', { type: 'user', action: 'updated', task: { status: 'completed', description: 'x', metadata: {} } });
    await flush();
    expect(speak).not.toHaveBeenCalled();

    // A voice-dispatched one does, flagged solicited so it bypasses the
    // proactive-enabled gate downstream.
    cosEvents.emit('tasks:changed', taskUpdate('completed'));
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toMatchObject({ source: 'task-complete', solicited: true, priority: 'normal' });
    expect(speak.mock.calls[0][0].text).toMatch(/Fix the backup test/);
  });

  it('accepts the string "true" voiceDispatch flag (markdown round-trip)', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });
    cosEvents.emit('tasks:changed', { type: 'user', action: 'updated', task: { status: 'completed', description: 'y', metadata: { voiceDispatch: 'true' } } });
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('uses high priority for a blocked (failed) dispatched task', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });
    cosEvents.emit('tasks:changed', taskUpdate('blocked'));
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].priority).toBe('high');
  });

  it('does NOT announce on non-terminal updates (retry → pending, spawn → in_progress)', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });
    cosEvents.emit('tasks:changed', taskUpdate('pending'));
    cosEvents.emit('tasks:changed', taskUpdate('in_progress'));
    await flush();
    expect(speak).not.toHaveBeenCalled();
  });

  it('suppresses the failure line for a user-terminated task', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });
    cosEvents.emit('tasks:changed', taskUpdate('blocked', { blockedCategory: 'user-terminated' }));
    await flush();
    expect(speak).not.toHaveBeenCalled();
  });

  it('ignores non-update actions (added/deleted/reordered)', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });
    cosEvents.emit('tasks:changed', { type: 'user', action: 'added', task: { status: 'completed', metadata: { voiceDispatch: true } } });
    await flush();
    expect(speak).not.toHaveBeenCalled();
  });

  it('does not announce when announceOnComplete is disabled', async () => {
    getVoiceConfig.mockResolvedValue({ enabled: true, llm: { codeAgent: { announceOnComplete: false } } });
    unwire = wireProactiveTriggers({ io: {}, speak });
    cosEvents.emit('tasks:changed', taskUpdate('completed'));
    await flush();
    expect(speak).not.toHaveBeenCalled();
  });

  it('announces an already-completed task only once when updated again', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });
    // A second updateTask() on the same already-completed task re-emits the
    // event with the same terminal status; the once-guard must suppress it.
    cosEvents.emit('tasks:changed', taskUpdate('completed'));
    await flush();
    cosEvents.emit('tasks:changed', taskUpdate('completed', { title: 'now with a PR url' }));
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('dedups a same-tick duplicate completion burst to one line', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });
    // Both emit on the same tick (no flush between) — the synchronous guard
    // must dedup before either reaches the async tail.
    cosEvents.emit('tasks:changed', taskUpdate('completed'));
    cosEvents.emit('tasks:changed', taskUpdate('completed'));
    await flush();
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('still announces a distinct terminal outcome (blocked then completed)', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });
    // Same task id, different terminal status: a blocked task later re-dispatched
    // to completed is a NEW outcome and must speak its success line.
    cosEvents.emit('tasks:changed', taskUpdate('blocked'));
    await flush();
    cosEvents.emit('tasks:changed', taskUpdate('completed'));
    await flush();
    expect(speak).toHaveBeenCalledTimes(2);
    const priorities = speak.mock.calls.map((c) => c[0].priority);
    expect(priorities).toEqual(['high', 'normal']);
  });

  it('rolls back the once-guard when the line was suppressed (ok:false), so a re-update re-announces', async () => {
    // First completion is suppressed downstream (quiet hours / voice off): the
    // outcome must NOT be marked announced, so a later identical re-update can
    // still speak it once the suppression clears.
    speak = vi.fn(async () => ({ ok: false, reason: 'quiet-hours' }));
    unwire = wireProactiveTriggers({ io: {}, speak });
    cosEvents.emit('tasks:changed', taskUpdate('completed'));
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);

    speak.mockResolvedValue({ ok: true });
    cosEvents.emit('tasks:changed', taskUpdate('completed'));
    await flush();
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('rolls back the once-guard when announceOnComplete is off, so re-enabling re-announces', async () => {
    getVoiceConfig.mockResolvedValue({ enabled: true, llm: { codeAgent: { announceOnComplete: false } } });
    unwire = wireProactiveTriggers({ io: {}, speak });
    cosEvents.emit('tasks:changed', taskUpdate('completed'));
    await flush();
    expect(speak).not.toHaveBeenCalled();

    // User re-enables completion announcements; a later re-update now speaks.
    getVoiceConfig.mockResolvedValue({ enabled: true, llm: { codeAgent: { announceOnComplete: true } } });
    cosEvents.emit('tasks:changed', taskUpdate('completed'));
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
  });
});
