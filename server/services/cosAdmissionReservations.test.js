import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetCosAdmissionReservations,
  acquireCosActionReservation,
  acquireCosGlobalSlot,
  pendingCosActionReservations,
  pendingCosGlobalReservations,
} from './cosAdmissionReservations.js';

describe('shared CoS admission reservations', () => {
  beforeEach(() => __resetCosAdmissionReservations());

  it('prevents a second admission while a global slot is reserved', () => {
    const first = acquireCosGlobalSlot({ agents: {}, limit: 1, reservationId: 'mind-turn' });
    expect(first.ok).toBe(true);
    expect(acquireCosGlobalSlot({ agents: {}, limit: 1, reservationId: 'task-1' })).toMatchObject({ ok: false });
    first.release();
    expect(pendingCosGlobalReservations()).toBe(0);
  });

  it('does not double-count a spawn reservation after its agent is running', () => {
    const first = acquireCosGlobalSlot({ agents: {}, limit: 2, reservationId: 'task-1' });
    const agents = { a1: { status: 'running', taskId: 'task-1' } };
    expect(pendingCosGlobalReservations(agents)).toBe(0);
    expect(acquireCosGlobalSlot({ agents, limit: 2, reservationId: 'task-2' }).ok).toBe(true);
    first.release();
  });

  it('atomically reserves the final daily action', () => {
    const budget = { maxActionsPerDay: 1, maxMinutesPerDay: null };
    const usage = { actions: 0, ms: 0 };
    const first = acquireCosActionReservation({ budget, usage, reservationId: 'mind-turn' });
    expect(first.ok).toBe(true);
    expect(acquireCosActionReservation({ budget, usage, reservationId: 'job-1' })).toMatchObject({ ok: false });
    first.release();
    expect(pendingCosActionReservations()).toBe(0);
  });
});
