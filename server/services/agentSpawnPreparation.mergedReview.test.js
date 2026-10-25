import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setImmediate as flushImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ loadState: vi.fn(), owner: vi.fn(), read: vi.fn(), update: vi.fn(),
  app: vi.fn(), origin: vi.fn(), probe: vi.fn(), lane: vi.fn(), execution: vi.fn(), emit: vi.fn(), releaseMarker: vi.fn() }));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: m.emit }, emitLog: vi.fn() }));
vi.mock('./cosState.js', () => ({ loadState: m.loadState }));
vi.mock('./agentState.js', () => ({ hasActiveTaskOwner: m.owner }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: m.read, updateTask: m.update }));
vi.mock('./apps.js', () => ({ getAppById: m.app }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: m.origin }));
vi.mock('./prProbe.js', () => ({ probeChangeRequestState: m.probe }));
vi.mock('./toolStateMachine.js', () => ({ createToolExecution: m.execution, startExecution: vi.fn(), completeExecution: vi.fn(), errorExecution: vi.fn() }));
vi.mock('./executionLanes.js', () => ({ determineLane: () => 'default', acquire: m.lane, release: vi.fn() }));
vi.mock('./agentPromptBuilder.js', () => ({ getAppWorkspace: vi.fn() }));
vi.mock('./instanceIdentity.js', () => ({ ensureInstanceId: async () => 'local-instance' }));
vi.mock('./appActivity.js', () => ({ releaseAppReviewMarker: m.releaseMarker }));
vi.mock('./retirementRecoveryCompletion.js', () => ({ isRetirementOnlyRecovery: () => false, settleRetirementRecoveryBeforeSpawn: vi.fn() }));

const queued = () => ({ id: 'sys-rl-example', taskType: 'internal', status: 'pending', priority: 'MEDIUM',
  description: 'Resolve the assigned PR', metadata: {
    app: 'local-app', reviewLoopFollowUp: 'true', reviewLoopPRBranch: 'fix/example',
    reviewLoopPRUrl: 'https://github.com/example/project/pull/42', prCompletion: 'review-then-merge',
    totalSpawnCount: '2', retryCount: '1', sourceTaskId: 'watchdog-example',
  } });
let directory; let file; let beforeWrite;
const readSaved = () => JSON.parse(readFileSync(file, 'utf8'));
const save = value => writeFileSync(file, JSON.stringify(value));
const prepare = async task => (await import('./agentSpawnPreparation.js')).prepareAgentSpawn(task);

beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'portos-review-dispatch-')); file = join(directory, 'task.json'); save(queued()); beforeWrite = null;
  m.read.mockImplementation(async () => readSaved());
  // Persisted adapter for the existing task-store snapshot/status CAS contract;
  // real CAS refusal is covered separately in cosTaskStore.test.js.
  m.update.mockImplementation(async (_id, patch, _type, options = {}) => {
    beforeWrite?.(); const current = readSaved();
    if ((options.expectedStatus && current.status !== options.expectedStatus)
      || (options.expectedTask && Object.entries(options.expectedTask).some(([key, value]) => !isDeepStrictEqual(current[key], value)))) return { statusChanged: true, task: current };
    const next = { ...current, ...patch, metadata: { ...current.metadata, ...patch.metadata } }; save(next); return next;
  });
  m.loadState.mockResolvedValue({ agents: {} }); m.owner.mockReturnValue(false); m.releaseMarker.mockResolvedValue();
  m.app.mockResolvedValue({ id: 'local-app', repoPath: '/synthetic/local-project' });
  m.origin.mockResolvedValue({ host: 'github.com', fullName: 'example/project' });
  m.probe.mockResolvedValue({ readable: true, prState: 'MERGED' });
  m.lane.mockReturnValue({ success: true }); m.execution.mockReturnValue({ id: 'execution-example' });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('saved review follow-up at the pre-provider spawn boundary', () => {
  it('settles the exact merged target before agent/lane/workspace allocation and survives restart replay', async () => {
    const cleanupStarted = Promise.withResolvers();
    const cleanupFinished = Promise.withResolvers();
    m.releaseMarker.mockImplementationOnce(() => { cleanupStarted.resolve(); return cleanupFinished.promise; });
    const snapshot = readSaved(); const dispatch = prepare(snapshot);
    await cleanupStarted.promise;
    await flushImmediate();
    expect(readSaved().status).toBe('completed');
    expect(m.emit).not.toHaveBeenCalled();
    cleanupFinished.resolve();
    expect(await dispatch).toBeNull();
    await flushImmediate();
    expect(m.emit).toHaveBeenCalledExactlyOnceWith('cos:dequeue-requested');
    expect(readSaved()).toMatchObject({ status: 'completed', metadata: {
      taskOutcome: { status: 'no-action-needed' }, reviewLoopRetiredReason: 'pull-request-merged-before-follow-up',
      totalSpawnCount: '2', retryCount: '1', mergedReviewFollowUp: { status: 'verified', prUrl: snapshot.metadata.reviewLoopPRUrl },
    } });
    expect(m.probe).toHaveBeenCalledWith('/synthetic/local-project', { number: 42, branch: 'fix/example' });
    expect(m.lane).not.toHaveBeenCalled(); expect(m.execution).not.toHaveBeenCalled(); expect(m.update).toHaveBeenCalledOnce();
    vi.resetModules();
    expect(await prepare(snapshot)).toBeNull(); expect(await prepare(readSaved())).toBeNull();
    await flushImmediate();
    expect(m.update).toHaveBeenCalledOnce(); expect(m.probe).toHaveBeenCalledOnce(); expect(m.lane).not.toHaveBeenCalled();
    expect(m.emit).toHaveBeenCalledExactlyOnceWith('cos:dequeue-requested');
  });
  it.each(['OPEN', null])('does not complete an open or unreadable PR (%s)', async prState => {
    m.probe.mockResolvedValue({ readable: prState !== null, prState });
    expect(await prepare(readSaved())).not.toBeNull(); expect(readSaved().status).toBe('pending');
    expect(readSaved().metadata.taskOutcome).toBeUndefined(); expect(m.lane).toHaveBeenCalledOnce();
  });
  it('does not infer delivery from an unrelated repository or missing local app', async () => {
    m.origin.mockResolvedValue({ host: 'github.com', fullName: 'other/project' });
    expect(await prepare(readSaved())).not.toBeNull(); expect(m.probe).not.toHaveBeenCalled(); expect(readSaved().status).toBe('pending');
    m.app.mockResolvedValue(null); expect(await prepare(readSaved())).not.toBeNull(); expect(readSaved().status).toBe('pending');
  });
  it.each([
    ['manual handoff', { prCompletion: 'leave-open' }], ['read-only assignment', { readOnly: 'true' }], ['explicit leave-open', { reviewLoopLeaveOpen: 'true' }],
    ['original cleanup obligation', { retirementReview: { release: { branch: 'fix/retained' } } }],
    ['preserved delivery corrections', { cleanupReviewTarget: { head: 'a'.repeat(40) } }],
    ['owned resume checkout', { resumedFromAgentId: 'agent-original', existingBranch: 'fix/retained' }],
  ])('preserves %s instead of settling independent work', async (_name, metadata) => {
    const task = readSaved(); task.metadata = { ...task.metadata, ...metadata }; save(task);
    expect(await prepare(task)).not.toBeNull(); expect(readSaved().status).toBe('pending');
    expect(readSaved().metadata).toMatchObject(metadata); expect(m.probe).not.toHaveBeenCalled();
  });
  it('stops a stale dispatcher without overwriting a concurrent claim or edited target', async () => {
    beforeWrite = () => { const current = readSaved(); current.status = 'in_progress'; current.metadata.reviewLoopPRUrl = 'https://github.com/example/project/pull/99'; save(current); };
    expect(await prepare(readSaved())).toBeNull();
    expect(readSaved()).toMatchObject({ status: 'in_progress', metadata: { reviewLoopPRUrl: 'https://github.com/example/project/pull/99' } });
    await flushImmediate();
    expect(m.emit).not.toHaveBeenCalled();
    expect(readSaved().metadata.taskOutcome).toBeUndefined(); expect(m.lane).not.toHaveBeenCalled();
  });
  it('leaves a new active owner intact after an awaited forge read', async () => {
    m.probe.mockImplementation(async () => { m.owner.mockReturnValue(true); return { readable: true, prState: 'MERGED' }; });
    expect(await prepare(readSaved())).toBeNull(); expect(readSaved().status).toBe('pending');
    expect(m.update).not.toHaveBeenCalled(); expect(m.lane).not.toHaveBeenCalled();
  });
});
