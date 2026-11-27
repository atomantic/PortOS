import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isAuthEnabled, verifyRequestSession } from '../auth.js';
import { PEER_SOCKET_ROOM } from '../socketIo.js';

import {
  registerVoiceOutputCandidate,
  claimVoiceOutput,
  releaseVoiceOutput,
  getVoiceOutputSocket,
  emitVoiceOutput,
  __resetVoiceOutput,
} from './voiceOutput.js';

vi.mock('../auth.js', () => ({
  isAuthEnabled: vi.fn(),
  verifyPassword: vi.fn(),
  verifyRequestSession: vi.fn(),
}));

// Minimal socket double: records emitted events and carries a stable id +
// `connected` flag (real Socket.IO sockets expose both).
const makeSocket = (id, { local = true, session, peer = false } = {}) => ({
  id,
  data: { portosLocalConnection: local },
  rooms: new Set(peer ? [PEER_SOCKET_ROOM] : []),
  handshake: { headers: session ? { cookie: `portos_auth=${session}` } : {} },
  connected: true,
  emitted: [],
  emit(event, payload) { this.emitted.push({ event, payload }); },
});

const emittedEvents = (sock) => sock.emitted.map((e) => e.event);

const makeIo = (...sockets) => ({
  emit: vi.fn(),
  sockets: { sockets: new Map(sockets.map((socket) => [socket.id, socket])) },
});
const speech = { sentence: 'Example reminder', wav: Buffer.alloc(8) };

describe('voiceOutput single-recipient routing', () => {
  beforeEach(() => {
    __resetVoiceOutput();
    isAuthEnabled.mockReset().mockResolvedValue(false);
    verifyRequestSession.mockReset().mockResolvedValue(null);
  });

  it('getVoiceOutputSocket is null with no candidates', () => {
    expect(getVoiceOutputSocket()).toBe(null);
  });

  it('delivers fallback speech to an older local browser on a password-free install', async () => {
    const local = makeSocket('local');
    const remote = makeSocket('remote', { local: false });
    const peer = makeSocket('peer', { peer: true });
    const io = makeIo(local, remote, peer);

    expect(await emitVoiceOutput(io, 'voice:speak', speech)).toEqual({ delivered: true, fallbackCount: 1 });
    expect(local.emitted).toEqual([{ event: 'voice:speak', payload: speech }]);
    expect(remote.emitted).toEqual([]);
    expect(peer.emitted).toEqual([]);
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('delivers fallback speech only to currently verified operator sessions when auth is enabled', async () => {
    isAuthEnabled.mockResolvedValue(true);
    verifyRequestSession.mockImplementation(async ({ headers }) =>
      headers.cookie === 'portos_auth=active-fixture' ? 'active-fixture' : null);
    const operator = makeSocket('operator', { local: false, session: 'active-fixture' });
    const expired = makeSocket('expired', { session: 'expired-fixture' });
    const io = makeIo(operator, expired);

    expect(await emitVoiceOutput(io, 'voice:speak', speech)).toEqual({ delivered: true, fallbackCount: 1 });
    expect(operator.emitted).toEqual([{ event: 'voice:speak', payload: speech }]);
    expect(expired.emitted).toEqual([]);
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('skips delivery when the registered primary has expired and no eligible sockets remain', async () => {
    isAuthEnabled.mockResolvedValue(true);
    const expired = makeSocket('expired', { session: 'expired-fixture' });
    const peer = makeSocket('peer', { peer: true });
    const io = makeIo(expired, peer);
    claimVoiceOutput(expired);
    expired.emitted.length = 0;

    expect(await emitVoiceOutput(io, 'voice:speak', speech)).toEqual({ delivered: false });
    expect(expired.emitted).toEqual([]);
    expect(peer.emitted).toEqual([]);
    expect(io.emit).not.toHaveBeenCalled();
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

  it('routes directly to the authorized primary with no fallback copies', async () => {
    const a = makeSocket('a');
    const b = makeSocket('b');
    registerVoiceOutputCandidate(a);
    registerVoiceOutputCandidate(b);
    claimVoiceOutput(b);

    const legacy = makeSocket('legacy');
    const io = makeIo(a, b, legacy);
    const res = await emitVoiceOutput(io, 'voice:speak', speech);

    expect(io.emit).not.toHaveBeenCalled();
    expect(res).toMatchObject({ delivered: true, socketId: 'b' });
    expect(a.emitted.filter((e) => e.event === 'voice:speak')).toEqual([]);
    expect(b.emitted.filter((e) => e.event === 'voice:speak')).toEqual([{ event: 'voice:speak', payload: speech }]);
    expect(legacy.emitted).toEqual([]);
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

  it('emitVoiceOutput returns not-delivered when io is absent and no candidate', async () => {
    expect(await emitVoiceOutput(null, 'voice:speak', {})).toMatchObject({ delivered: false });
  });
});
