import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerVoiceOutputCandidate,
  claimVoiceOutput,
  releaseVoiceOutput,
  getVoiceOutputSocket,
  emitVoiceOutput,
  __resetVoiceOutput,
} from './voiceOutput.js';

// Minimal socket double: records emitted events and carries a stable id +
// `connected` flag (real Socket.IO sockets expose both).
const makeSocket = (id) => ({
  id,
  connected: true,
  emitted: [],
  emit(event, payload) { this.emitted.push({ event, payload }); },
});

const emittedEvents = (sock) => sock.emitted.map((e) => e.event);

describe('voiceOutput single-recipient routing', () => {
  beforeEach(() => __resetVoiceOutput());

  it('getVoiceOutputSocket is null with no candidates', () => {
    expect(getVoiceOutputSocket()).toBe(null);
  });

  it('emitVoiceOutput falls back to io.emit only when no candidate is announced', () => {
    // Backward-compat path: a pre-upgrade client speaks the same voice:speak
    // event but never announces, so with no candidate we broadcast rather than
    // silently drop its proactive audio. In normal operation a tab always
    // announces, so this path is not taken (see the routing test below).
    const io = { emit: vi.fn() };
    const res = emitVoiceOutput(io, 'voice:speak', { sentence: 'hi' });
    expect(io.emit).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledWith('voice:speak', { sentence: 'hi' });
    expect(res).toMatchObject({ delivered: true, broadcast: true });
  });

  it('registering a candidate does NOT auto-steal primary, but is promoted lazily', () => {
    const a = makeSocket('a');
    registerVoiceOutputCandidate(a);
    // No explicit claim, no voice:output:primary emitted yet.
    expect(emittedEvents(a)).not.toContain('voice:output:primary');
    // But the sole candidate is the lazy recipient so audio has a home.
    expect(getVoiceOutputSocket()).toBe(a);
    // And lazy promotion notifies the elected tab so its UI reflects it's now
    // the speaker (it never claimed, so this is the only signal it gets).
    expect(emittedEvents(a)).toContain('voice:output:primary');
  });

  it('emitVoiceOutput routes to the single primary, not other candidates', () => {
    const a = makeSocket('a');
    const b = makeSocket('b');
    registerVoiceOutputCandidate(a);
    registerVoiceOutputCandidate(b);
    claimVoiceOutput(b);

    const io = { emit: vi.fn() };
    const res = emitVoiceOutput(io, 'voice:speak', { sentence: 'hello' });

    expect(io.emit).not.toHaveBeenCalled();
    expect(res).toMatchObject({ delivered: true, socketId: 'b' });
    expect(a.emitted.filter((e) => e.event === 'voice:speak')).toHaveLength(0);
    expect(b.emitted.filter((e) => e.event === 'voice:speak')).toHaveLength(1);
  });

  it('claim hands off primary: detaches the previous holder, notifies the new one', () => {
    const a = makeSocket('a');
    const b = makeSocket('b');
    registerVoiceOutputCandidate(a);
    registerVoiceOutputCandidate(b);

    claimVoiceOutput(a);
    expect(emittedEvents(a)).toContain('voice:output:primary');

    claimVoiceOutput(b);
    expect(emittedEvents(a)).toContain('voice:output:detached');
    expect(emittedEvents(b)).toContain('voice:output:primary');
    expect(getVoiceOutputSocket()).toBe(b);
  });

  it('re-claiming by the current primary is a no-op (no duplicate events)', () => {
    const a = makeSocket('a');
    registerVoiceOutputCandidate(a);
    claimVoiceOutput(a);
    a.emitted = [];
    claimVoiceOutput(a);
    expect(a.emitted).toHaveLength(0);
  });

  it('releasing the primary promotes the latest remaining candidate', () => {
    const a = makeSocket('a');
    const b = makeSocket('b');
    const c = makeSocket('c');
    registerVoiceOutputCandidate(a);
    registerVoiceOutputCandidate(b);
    registerVoiceOutputCandidate(c);
    claimVoiceOutput(a);

    releaseVoiceOutput(a);
    // Latest remaining candidate (c, registered last) is promoted.
    const next = getVoiceOutputSocket();
    expect(next).toBe(c);
    expect(emittedEvents(c)).toContain('voice:output:primary');
  });

  it('promotion follows the most-recently-focused (claimed) tab, not connect order', () => {
    const a = makeSocket('a');
    const b = makeSocket('b');
    const c = makeSocket('c');
    registerVoiceOutputCandidate(a);
    registerVoiceOutputCandidate(b);
    registerVoiceOutputCandidate(c);
    // User focuses a, then b — b is primary, but a was focused more recently
    // than c (which was only ever connected, never claimed).
    claimVoiceOutput(a);
    claimVoiceOutput(b);
    // b (the primary tab) disconnects.
    releaseVoiceOutput(b);
    // a inherits output (last focused survivor), NOT c (newest connected).
    expect(getVoiceOutputSocket()).toBe(a);
  });

  it('promotes a focused survivor over a background tab that reconnected later', () => {
    const a = makeSocket('a');
    const c = makeSocket('c');
    registerVoiceOutputCandidate(a);
    registerVoiceOutputCandidate(c);
    claimVoiceOutput(a); // user focused a
    claimVoiceOutput(c); // then focused c → c is primary
    // A background tab announces AFTER the last claim (e.g. a hidden tab
    // reconnecting) — newest in connection order, but never focused.
    const bg = makeSocket('bg');
    registerVoiceOutputCandidate(bg);

    releaseVoiceOutput(c); // primary disconnects
    // a (last-focused survivor) inherits output, NOT the newer background tab —
    // claim recency wins over connection order.
    expect(getVoiceOutputSocket()).toBe(a);
  });

  it('releasing a NON-primary candidate leaves primary unchanged', () => {
    const a = makeSocket('a');
    const b = makeSocket('b');
    registerVoiceOutputCandidate(a);
    registerVoiceOutputCandidate(b);
    claimVoiceOutput(a);

    releaseVoiceOutput(b);
    expect(getVoiceOutputSocket()).toBe(a);
  });

  it('a disconnected primary is pruned and not chosen', () => {
    const a = makeSocket('a');
    const b = makeSocket('b');
    registerVoiceOutputCandidate(a);
    registerVoiceOutputCandidate(b);
    claimVoiceOutput(a);

    a.connected = false; // socket dropped without a release call
    expect(getVoiceOutputSocket()).toBe(b);
  });

  it('emitVoiceOutput returns not-delivered when io is absent and no candidate', () => {
    expect(emitVoiceOutput(null, 'voice:speak', {})).toMatchObject({ delivered: false });
  });
});
