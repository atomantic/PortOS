import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./realtimeRuntime.js', () => ({ ensureRealtimeSidecar: vi.fn(), scheduleRealtimeIdleStop: vi.fn() }));

import { scheduleRealtimeIdleStop } from './realtimeRuntime.js';
import { openRealtimeCall, realtimePersona } from './realtimeSession.js';

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
  text(obj) { this.emit('message', Buffer.from(JSON.stringify(obj)), false); }
}

const open = async ({ runDelegate = vi.fn().mockResolvedValue('It is 9 PM.') } = {}) => {
  const ws = new FakeSocket();
  const emit = vi.fn();
  const connect = vi.fn(() => ws);
  const ensureSidecar = vi.fn().mockResolvedValue({ url: 'ws://127.0.0.1:5569/', token: 'secret-tok' });
  const pending = openRealtimeCall({ cfg: { realtime: { size: '4B' }, llm: { personality: { name: 'Ada' } } }, emit, runDelegate, connect, ensureSidecar });
  await Promise.resolve();
  ws.text({ type: 'ready' });
  const call = await pending;
  return { ws, emit, call, runDelegate, ensureSidecar, connect };
};

describe('openRealtimeCall', () => {
  it('starts the sidecar with the persona, authenticates via Bearer header, and reports the call live once ready', async () => {
    const { emit, ensureSidecar, connect } = await open();
    expect(ensureSidecar).toHaveBeenCalledWith({ size: '4B' }, { persona: expect.stringContaining('You are Ada') });
    expect(connect).toHaveBeenCalledWith('ws://127.0.0.1:5569/', { headers: { Authorization: 'Bearer secret-tok' } });
    expect(emit).toHaveBeenCalledWith('voice:realtime:state', { active: true });
  });

  it('relays microphone audio in and reply audio out', async () => {
    const { ws, emit, call } = await open();
    const mic = Buffer.alloc(640);
    call.pushAudio(mic);
    expect(ws.sent.at(-1)).toBe(mic);
    const reply = Buffer.alloc(960);
    ws.emit('message', reply, true);
    expect(emit).toHaveBeenCalledWith('voice:realtime:audio', { pcm: reply, sampleRate: 24000 });
  });

  it('runs a delegated task through the tool pipeline and hands the result back to the voice', async () => {
    const { ws, emit, runDelegate } = await open();
    ws.text({ type: 'delegate', call_id: 'c1', task: 'What time is it?' });
    await vi.waitFor(() => expect(ws.sent.some((m) => typeof m === 'string' && m.includes('tool_result'))).toBe(true));
    expect(runDelegate).toHaveBeenCalledWith('What time is it?');
    expect(JSON.parse(ws.sent.find((m) => typeof m === 'string'))).toEqual({ type: 'tool_result', call_id: 'c1', output: 'It is 9 PM.' });
    expect(emit).toHaveBeenCalledWith('voice:realtime:delegate', { callId: 'c1', task: 'What time is it?' });
    expect(emit).toHaveBeenCalledWith('voice:realtime:result', { callId: 'c1', task: 'What time is it?', text: 'It is 9 PM.' });
  });

  it('tells the voice when a delegated task fails instead of leaving it waiting', async () => {
    const { ws } = await open({ runDelegate: vi.fn().mockRejectedValue(new Error('no tool')) });
    ws.text({ type: 'delegate', call_id: 'c2', task: 'log it' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(ws.sent[0]).output).toBe('That failed: no tool');
  });

  it('forwards barge-in and replies, and frees the model after hang-up', async () => {
    const { ws, emit, call } = await open();
    ws.text({ type: 'interrupt' });
    ws.text({ type: 'reply', text: 'Hi there', cancelled: false });
    ws.text({ type: 'event', ev: 'turn_check' });
    expect(emit).toHaveBeenCalledWith('voice:realtime:interrupt', {});
    expect(emit).toHaveBeenCalledWith('voice:realtime:reply', { text: 'Hi there', cancelled: false });
    expect(emit).not.toHaveBeenCalledWith('voice:realtime:event', expect.objectContaining({ ev: 'turn_check' }));
    call.close();
    expect(scheduleRealtimeIdleStop).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('voice:realtime:state', { active: false, reason: 'hangup' });
  });

  it('rejects when the sidecar closes before it is ready and preserves close reason without emitting sidecar-closed', async () => {
    const ws = new FakeSocket();
    const emit = vi.fn();
    const pending = openRealtimeCall({ cfg: {}, emit, runDelegate: vi.fn(), connect: () => ws,
      ensureSidecar: vi.fn().mockResolvedValue({ url: 'ws://x' }) });
    await Promise.resolve();
    ws.readyState = 3;
    ws.emit('close', 1013, Buffer.from('one conversation at a time'));
    await expect(pending).rejects.toThrow('closed before it was ready (one conversation at a time)');
    expect(emit).not.toHaveBeenCalledWith('voice:realtime:state', expect.objectContaining({ reason: 'sidecar-closed' }));
  });

  it('times out and closes the socket if the sidecar never sends ready', async () => {
    const ws = new FakeSocket();
    const closeSpy = vi.spyOn(ws, 'close');
    const pending = openRealtimeCall({
      cfg: {},
      emit: vi.fn(),
      runDelegate: vi.fn(),
      connect: () => ws,
      ensureSidecar: vi.fn().mockResolvedValue({ url: 'ws://x' }),
      readyTimeoutMs: 15,
    });
    await expect(pending).rejects.toThrow('timed out before it was ready');
    expect(closeSpy).toHaveBeenCalled();
  });

  it('schedules idle stop and invokes onClose when the sidecar closes after going live', async () => {
    const ws = new FakeSocket();
    const emit = vi.fn();
    const onClose = vi.fn();
    vi.mocked(scheduleRealtimeIdleStop).mockClear();
    const pending = openRealtimeCall({
      cfg: {},
      emit,
      runDelegate: vi.fn(),
      onClose,
      connect: () => ws,
      ensureSidecar: vi.fn().mockResolvedValue({ url: 'ws://x' }),
    });
    await Promise.resolve();
    ws.text({ type: 'ready' });
    await pending;
    ws.close();
    expect(scheduleRealtimeIdleStop).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('sidecar-closed');
    expect(emit).toHaveBeenCalledWith('voice:realtime:state', { active: false, reason: 'sidecar-closed' });
  });

  it('aborts cleanly during ready without emitting active state', async () => {
    const ws = new FakeSocket();
    const emit = vi.fn();
    const ctrl = new AbortController();
    const pending = openRealtimeCall({
      cfg: {},
      emit,
      runDelegate: vi.fn(),
      signal: ctrl.signal,
      connect: () => ws,
      ensureSidecar: vi.fn().mockResolvedValue({ url: 'ws://x' }),
    });
    await Promise.resolve();
    ctrl.abort();
    expect(await pending).toBeNull();
    expect(emit).not.toHaveBeenCalledWith('voice:realtime:state', expect.anything());
  });

  it('notifies onClose when the sidecar closes unexpectedly', async () => {
    const ws = new FakeSocket();
    const emit = vi.fn();
    const onClose = vi.fn();
    const pending = openRealtimeCall({
      cfg: {},
      emit,
      runDelegate: vi.fn(),
      onClose,
      connect: () => ws,
      ensureSidecar: vi.fn().mockResolvedValue({ url: 'ws://x' }),
    });
    await Promise.resolve();
    ws.text({ type: 'ready' });
    await pending;
    ws.close();
    expect(onClose).toHaveBeenCalledWith('sidecar-closed');
    expect(emit).toHaveBeenCalledWith('voice:realtime:state', { active: false, reason: 'sidecar-closed' });
  });

  it('does not emit a synthetic delegate result after the call has closed', async () => {
    let finishDelegate;
    const runDelegate = vi.fn(() => new Promise((resolve) => { finishDelegate = resolve; }));
    const { ws, emit, call } = await open({ runDelegate });
    ws.text({ type: 'delegate', call_id: 'c3', task: 'Check status' });
    await vi.waitFor(() => expect(runDelegate).toHaveBeenCalledWith('Check status'));
    call.close();
    finishDelegate('');
    await Promise.resolve();
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalledWith('voice:realtime:result', expect.anything());
    expect(ws.sent).toEqual([]);
  });
});

describe('realtimePersona', () => {
  it('builds the persona from the Voice personality and honors the personality switch', () => {
    expect(realtimePersona({ llm: { personality: { name: 'Ada', role: 'Chief of Staff', speechStyle: 'brief', traits: ['warm'] } } }))
      .toBe('You are Ada, Chief of Staff for the user. Speech style: brief. Personality: warm.');
    expect(realtimePersona({ llm: { usePersonality: false } })).toBe('');
  });
});
