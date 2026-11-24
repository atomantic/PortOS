/**
 * The `agent:completed` handler registered by init(): perpetual refill, then
 * dequeue. Drives the real listener through `cosEvents.emit` with the refill's
 * collaborators doubled, so ordering and gating are observed rather than
 * grepped from source. Own file because the module-wide mocks would replace
 * helpers cos.test.js exercises for real.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const calls = vi.hoisted(() => ({ log: [], parkActive: false, refillGate: null }));
const baseConfig = vi.hoisted(() => ({
  improvementEnabled: true, idleReviewEnabled: true, domainAutonomy: { cos: 'execute' }, maxConcurrentAgents: 3,
}));

vi.mock('../../lib/maintenanceAdmission.js', async original => {
  const actual = await original();
  // dequeueNextTask's first statement; recording it marks "dequeue ran".
  return { ...actual, maintenance: { ...actual.maintenance, held: () => { calls.log.push('dequeue'); return true; }, agentDiskPressure: () => null } };
});
vi.mock('./cosState.js', async importOriginal => ({
  ...(await importOriginal()),
  ensureDirectories: vi.fn(async () => {}),
  loadState: vi.fn(async () => ({ running: false, paused: false, agents: {}, config: structuredClone(baseConfig) })),
}));
vi.mock('./cosTaskStore.js', async importOriginal => ({
  ...(await importOriginal()),
  getCosTasks: vi.fn(async () => ({ tasks: [] })),
}));
vi.mock('../taskSchedule.js', async importOriginal => ({
  ...(await importOriginal()),
  loadSchedule: vi.fn(async () => ({ tasks: { 'claim-issue': { enabled: true, perpetual: true } } })),
  isPerpetualParkActive: vi.fn(async () => calls.parkActive),
  queuePerpetualRefill: vi.fn(async () => {
    calls.log.push('refill:onDemand');
    await calls.refillGate;
    return {};
  }),
}));
vi.mock('./cosImprovementTasks.js', async importOriginal => ({
  ...(await importOriginal()),
  queueEligibleImprovementTasks: vi.fn(async () => { calls.log.push('refill:queue'); }),
}));
vi.mock('../blockedSystemInvestigation.js', () => ({ recoverBlockedSystemTask: vi.fn(async () => {}) }));

const { init } = await import('./cos.js');
const { cosEvents } = await import('./cosEvents.js');
const { setDaemonRunning } = await import('./cosState.js');
const taskSchedule = await import('../taskSchedule.js');
const { queueEligibleImprovementTasks } = await import('./cosImprovementTasks.js');

const agentOf = (overrides = {}) => ({
  id: 'agent-1', taskId: 'task-1', result: { success: true },
  metadata: { taskAnalysisType: 'claim-issue', taskApp: 'app-1' }, ...overrides,
});
const waitForLog = async (entry) => {
  for (let i = 0; i < 2000 && !calls.log.includes(entry); i++) await new Promise(r => setImmediate(r));
  expect(calls.log).toContain(entry);
};
const complete = async (agent) => {
  cosEvents.emit('agent:completed', agent);
  await waitForLog('dequeue');
};

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await init();
});

beforeEach(() => {
  calls.log.length = 0;
  calls.parkActive = false;
  calls.refillGate = null;
  setDaemonRunning(true);
  vi.clearAllMocks();
});

afterEach(() => setDaemonRunning(false));

describe('agent:completed → perpetual refill → dequeue', () => {
  it('a failed run skips the refill but still dequeues', async () => {
    await complete(agentOf({ result: { success: false } }));
    expect(calls.log).toEqual(['dequeue']);
  });

  it('a live perpetual park on a manual drain skips the re-issue (#3848)', async () => {
    calls.parkActive = true;
    await complete(agentOf({ metadata: { taskAnalysisType: 'claim-issue', taskApp: 'app-1', taskOnDemand: true } }));
    expect(taskSchedule.isPerpetualParkActive).toHaveBeenCalledWith('claim-issue', 'app-1');
    expect(taskSchedule.queuePerpetualRefill).not.toHaveBeenCalled();
    expect(calls.log).toEqual(['dequeue']);
  });

  it('an unparked manual drain re-issues for the same type and app before dequeue', async () => {
    await complete(agentOf({ metadata: { taskAnalysisType: 'claim-issue', taskApp: 'app-1', taskOnDemand: true } }));
    expect(taskSchedule.queuePerpetualRefill).toHaveBeenCalledWith('claim-issue', 'app-1');
    expect(calls.log).toEqual(['refill:onDemand', 'dequeue']);
  });

  it('a scheduled drain forwards the completing task as ignoreTaskId', async () => {
    await complete(agentOf());
    expect(queueEligibleImprovementTasks).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ ignoreTaskId: 'task-1', wakeAfterRecord: false }),
    );
    expect(calls.log).toEqual(['refill:queue', 'dequeue']);
  });

  it('dequeue waits for a slow refill to settle', async () => {
    let release;
    calls.refillGate = new Promise(resolve => { release = resolve; });
    cosEvents.emit('agent:completed', agentOf({ metadata: { taskAnalysisType: 'claim-issue', taskApp: 'app-1', taskOnDemand: true } }));
    await waitForLog('refill:onDemand');
    for (let i = 0; i < 200; i++) await new Promise(r => setImmediate(r));
    expect(calls.log).toEqual(['refill:onDemand']);
    release();
    await waitForLog('dequeue');
    expect(calls.log).toEqual(['refill:onDemand', 'dequeue']);
  });

  it('a refill failure is contained and dequeue still runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    queueEligibleImprovementTasks.mockRejectedValueOnce(new Error('boom'));
    await complete(agentOf());
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Perpetual refill after agent-1 failed'));
  });
});
