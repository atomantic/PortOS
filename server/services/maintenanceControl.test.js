import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

const gate = vi.hoisted(() => ({ root: null, admission: null }));
vi.mock('../lib/maintenanceAdmission.js', async () => {
  const actual = await vi.importActual('../lib/maintenanceAdmission.js');
  const { mkdtempSync: mk } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  gate.root = mk(j(tmp(), 'maintenance-control-'));
  gate.admission = actual.createMaintenanceAdmission(gate.root);
  return { ...actual, maintenance: gate.admission };
});
import { bindMaintenanceIo } from './maintenanceControl.js';

afterAll(() => rmSync(gate.root, { recursive: true, force: true }));

const sent = [];
const io = { emit: (name, payload) => sent.push({ name, payload }) };
const count = name => sent.filter(e => e.name === name).length;

describe('maintenance notifications', () => {
  it('keeps detailed invalidations but only pushes the coarse readiness projection when it changes', async () => {
    bindMaintenanceIo(io);
    const maintenance = gate.admission;

    // Normal admit/settle churn rewrites the journal but not the banner projection.
    const op = maintenance.admit('agent', 'resource-that-must-not-leak');
    await vi.waitFor(() => expect(count('maintenance:changed')).toBeGreaterThanOrEqual(1));
    op.finish();
    await vi.waitFor(() => expect(count('maintenance:changed')).toBeGreaterThanOrEqual(2));
    expect(count('maintenance:readiness')).toBe(0);

    // Hold with a running operation: draining with a blocker count.
    const running = maintenance.admit('agent', 'resource-that-must-not-leak');
    maintenance.begin({ reason: 'Service work', owner: 'Operator' });
    await vi.waitFor(() => expect(count('maintenance:readiness')).toBe(1));
    expect(sent.find(e => e.name === 'maintenance:readiness').payload).toEqual({ state: 'draining', blockerCount: 1 });

    // Settling the blocker moves to ready (count no longer displayed).
    running.finish();
    await vi.waitFor(() => expect(count('maintenance:readiness')).toBe(2));
    expect(sent.filter(e => e.name === 'maintenance:readiness')[1].payload).toEqual({ state: 'ready', blockerCount: 0 });

    // Leaving the hold returns to normal.
    const { hold } = maintenance.status();
    maintenance.resume({ id: hold.id, revision: hold.revision });
    await vi.waitFor(() => expect(count('maintenance:readiness')).toBe(3));

    // Nothing private is broadcast.
    expect(JSON.stringify(sent)).not.toMatch(/resource-that-must-not-leak|pid|owner|hold/i);
  });
});
