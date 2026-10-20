import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const gateRef = vi.hoisted(() => ({ gate: null }));
vi.mock('../lib/maintenanceAdmission.js', async importOriginal => ({
  ...(await importOriginal()),
  maintenance: new Proxy({}, { get: (_t, key) => gateRef.gate[key] }),
}));
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import { reconcileStaleAgentReservations, releaseAgentReservation } from './agentMaintenanceReservations.js';

let root;
const resources = () => gateRef.gate.status().blockers.map(b => b.resource).sort();
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'agent-reservations-'));
  gateRef.gate = createMaintenanceAdmission(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('releaseAgentReservation', () => {
  it('drops only that agent reservation and is idempotent', async () => {
    gateRef.gate.admit('agent', 'agent-a');
    gateRef.gate.admit('agent', 'agent-b');
    await releaseAgentReservation('agent-a');
    await releaseAgentReservation('agent-a');
    expect(resources()).toEqual(['agent-b']);
  });

  it('does not throw when the journal needs recovery', async () => {
    gateRef.gate.admit('agent', 'agent-a');
    fs.writeFileSync(join(gateRef.gate.directory, 'state.json'), '{not json');
    await expect(releaseAgentReservation('agent-a')).resolves.toBeUndefined();
  });
});

describe('reconcileStaleAgentReservations', () => {
  const agents = [
    { id: 'agent-done', status: 'completed' },
    { id: 'agent-live', status: 'running' },
    { id: 'agent-paused', status: 'paused' },
    { id: 'agent-hurt', status: 'completed' },
  ];
  const seed = () => {
    for (const id of ['agent-done', 'agent-gone', 'agent-live', 'agent-paused']) gateRef.gate.admit('agent', id);
    gateRef.gate.admit('agent', 'agent-hurt').markUnsettled();
    gateRef.gate.admit('provider', 'agent-done');
  };

  it('releases completed, paused or absent agents with a dead owner and nothing else', async () => {
    seed();
    expect(await reconcileStaleAgentReservations({ agents, pidAlive: () => false })).toBe(3);
    expect(resources()).toEqual(['agent-done', 'agent-hurt', 'agent-live']);
    expect(gateRef.gate.status().blockers.filter(b => b.resource === 'agent-done').map(b => b.kind)).toEqual(['provider']);
  });

  it('leaves every reservation whose owning process is alive', async () => {
    seed();
    expect(await reconcileStaleAgentReservations({ agents, pidAlive: () => true })).toBe(0);
    expect(resources()).toHaveLength(6);
  });

  it('skips quietly when the journal needs recovery', async () => {
    seed();
    fs.writeFileSync(join(gateRef.gate.directory, 'state.json'), '{not json');
    expect(await reconcileStaleAgentReservations({ agents, pidAlive: () => false })).toBe(0);
  });
});
