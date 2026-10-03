import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ history: [], live: new Set() }));
vi.mock('./agentRunEventLog.js', () => ({ readPersistentMindHistory: vi.fn(async () => mock.history) }));
vi.mock('./eidoverseTravel.js', () => ({ isEidoverseVisitLive: (id) => mock.live.has(id) }));

const { readPersistentMindVisitContinuationPrompt } = await import('./persistentMindVisitContinuation.js');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const A = 'aa'.repeat(24);
const B = 'bb'.repeat(24);
let sequence = 0;
const result = (data) => ({ mindId: 'cos-persistent-mind', kind: 'mind.capability.result', sequence: sequence += 1, eventId: `e${sequence}`, data: { success: true, ...data } });
const granted = { visitEidoversePeers: true };
const prompt = (capabilities = granted) => readPersistentMindVisitContinuationPrompt({ capabilities, now: NOW });

beforeEach(() => { mock.history = []; mock.live = new Set(); sequence = 0; });

describe('cross-wake Eidoverse visit continuation (#9791)', () => {
  it('hands the next wake the handle of a still-live visit', async () => {
    mock.history = [result({ displayText: 'eidoverse.visit completed', tool: 'eidoverse.visit', visitReceipt: { visitId: A, peerId: 'peer-1', expiresAt: NOW + 60_000 } })];
    mock.live.add(A);
    const text = await prompt();
    expect(text).toContain(`ACTIVE visitId=${A} peerId=peer-1`);
    expect(text).toContain('do NOT call eidoverse.visit again');
  });

  it('reports a restart-lost or expired visit instead of offering it as active', async () => {
    mock.history = [
      result({ visitReceipt: { visitId: A, peerId: 'peer-1', expiresAt: NOW + 60_000 } }),
      result({ visitReceipt: { visitId: B, peerId: 'peer-2', expiresAt: NOW - 1000 } }),
    ];
    const text = await prompt();
    expect(text).toContain(`ENDED visitId=${A}`);
    expect(text).toContain(`EXPIRED visitId=${B}`);
    expect(text).not.toContain('- ACTIVE');
  });

  it('retires a visit after a successful leave and forgets long-expired ones', async () => {
    mock.history = [
      result({ visitReceipt: { visitId: A, peerId: 'peer-1', expiresAt: NOW + 60_000 } }),
      result({ visitRetired: A }),
      result({ visitReceipt: { visitId: B, peerId: 'peer-2', expiresAt: NOW - 25 * 60 * 60 * 1000 } }),
    ];
    mock.live.add(A);
    expect(await prompt()).toBe('');
  });

  it('stays silent without the grant, for completion-only history, and for malformed receipts', async () => {
    mock.history = [
      result({ displayText: 'eidoverse.visit completed', tool: 'eidoverse.visit' }),
      result({ visitReceipt: { visitId: 'not-a-handle', peerId: 'peer-1', expiresAt: NOW + 60_000 } }),
      { ...result({ visitReceipt: { visitId: A, peerId: 'peer-1', expiresAt: NOW + 60_000 } }), data: { success: false, visitReceipt: { visitId: A, peerId: 'peer-1', expiresAt: NOW + 60_000 } } },
    ];
    mock.live.add(A);
    expect(await prompt()).toBe('');
    mock.history = [result({ visitReceipt: { visitId: A, peerId: 'peer-1', expiresAt: NOW + 60_000 } })];
    expect(await prompt({ visitEidoversePeers: false })).toBe('');
  });
});
