import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const mockCosState = vi.hoisted(() => ({
  // Use $TMPDIR (falls back to /tmp) rather than a hardcoded /private/tmp — the
  // latter exists on macOS (where /tmp symlinks to it) but not on Linux CI,
  // where `mkdir(recursive)` then tries to create `/private` at the root and
  // hits EACCES. process.env is safe to read inside a vi.hoisted factory
  // (imported bindings like `os.tmpdir` are not yet initialized at hoist time).
  agentsDir: `${process.env.TMPDIR || '/tmp'}/portos-cos-agents-test-${process.pid}`,
  state: null
}));

vi.mock('./cosState.js', () => ({
  AGENTS_DIR: mockCosState.agentsDir,
  loadState: vi.fn(async () => mockCosState.state),
  saveState: vi.fn(),
  withStateLock: async (fn) => fn()
}));

vi.mock('./domainUsage.js', () => ({
  recordDomainUsage: vi.fn(async () => {})
}));

import { getAgent, createAgentOutputBatcher, completeAgent, updateAgent, registerAgent } from './cosAgents.js';
import { saveState } from './cosState.js';
import { recordDomainUsage } from './domainUsage.js';
import { cosEvents } from './cosEvents.js';

describe('cosAgents', () => {
  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    mockCosState.state = { agents: {} };
  });

  afterEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
  });

  it('hydrates paused agents with full preserved output from output.txt', async () => {
    const agentId = 'agent-paused';
    const pausedAt = '2026-05-25T12:00:00.000Z';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'paused',
      pausedAt,
      output: [{ line: 'state tail only', timestamp: pausedAt }]
    };

    await mkdir(join(mockCosState.agentsDir, agentId), { recursive: true });
    await writeFile(join(mockCosState.agentsDir, agentId, 'output.txt'), 'full line one\nfull line two\n');

    const agent = await getAgent(agentId);

    expect(agent.status).toBe('paused');
    expect(agent.output).toEqual([
      { line: 'full line one', timestamp: pausedAt },
      { line: 'full line two', timestamp: pausedAt }
    ]);
  });

  it('persists post-completion metadata updates in the archived agent record', async () => {
    const agentId = 'agent-completed';
    const completedAt = '2026-05-25T12:00:00.000Z';
    mockCosState.state.agents[agentId] = { id: agentId, status: 'completed', completedAt, metadata: {}, output: [] };
    const archiveDir = join(mockCosState.agentsDir, '2026-05-25', agentId);
    await mkdir(archiveDir, { recursive: true });

    await updateAgent(agentId, { metadata: { malwareScan: { verdict: 'DANGEROUS' } } });

    const persisted = JSON.parse(await readFile(join(archiveDir, 'metadata.json'), 'utf8'));
    expect(persisted.metadata.malwareScan.verdict).toBe('DANGEROUS');
  });
});

describe('completeAgent budget-ledger ordering (#1683)', () => {
  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    mockCosState.state = { agents: {}, stats: { tasksCompleted: 0, errors: 0 } };
    recordDomainUsage.mockClear();
  });

  afterEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    cosEvents.removeAllListeners('agent:completed');
  });

  it('records the autonomous action usage BEFORE emitting agent:completed', async () => {
    // The agent:completed handler schedules dequeueNextTask(), whose daily
    // action-budget gate reads the usage ledger. If the emit beats the ledger
    // write, the gate counts stale usage and can admit one spawn past the cap.
    const order = [];
    recordDomainUsage.mockImplementation(async () => { order.push('usage'); });
    cosEvents.on('agent:completed', () => { order.push('completed'); });

    const agentId = 'agent-autonomous';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' }
    };

    await completeAgent(agentId, { success: true, duration: 1200 });

    expect(recordDomainUsage).toHaveBeenCalledWith('cos', { actions: 1, ms: 1200 });
    expect(order).toEqual(['usage', 'completed']);
  });

  it('still emits agent:completed when the usage-ledger write rejects', async () => {
    // recordDomainUsage is .catch-guarded, so a ledger-write failure must not
    // swallow the completion event — the scheduler still needs to advance.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    recordDomainUsage.mockRejectedValueOnce(new Error('ledger disk full'));

    const agentId = 'agent-ledger-fail';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' }
    };
    let emitted = false;
    cosEvents.on('agent:completed', () => { emitted = true; });

    await completeAgent(agentId, { success: true, duration: 500 });

    expect(emitted).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to record CoS budget usage for ${agentId}`)
    );
    consoleSpy.mockRestore();
  });

  it('skips usage accounting for user tasks but still emits agent:completed', async () => {
    const agentId = 'agent-user';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'user' }
    };
    let emitted = false;
    cosEvents.on('agent:completed', () => { emitted = true; });

    await completeAgent(agentId, { success: true });

    expect(recordDomainUsage).not.toHaveBeenCalled();
    expect(emitted).toBe(true);
  });
});

describe('completeAgent idempotence (#3384)', () => {
  const emittedCompletions = [];

  beforeEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    await mkdir(mockCosState.agentsDir, { recursive: true });
    mockCosState.state = { agents: {}, stats: { tasksCompleted: 0, errors: 0 } };
    emittedCompletions.length = 0;
    recordDomainUsage.mockClear();
    recordDomainUsage.mockImplementation(async () => {});
    cosEvents.on('agent:completed', (agent) => emittedCompletions.push(agent));
  });

  afterEach(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
    cosEvents.removeAllListeners('agent:completed');
  });

  it('keeps the first verdict when a duplicate completion arrives', async () => {
    // Regression: a stray runner `agent:completed` for an agent that had already
    // finalized on its own sentinel replaced a recorded success with
    // `success: false, exitCode: 143`, flipping the card to Failed and requeueing
    // a finished task.
    const agentId = 'agent-duplicate-completion';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' },
      output: []
    };

    const first = await completeAgent(agentId, { success: true, exitCode: 0, duration: 1000 });
    expect(first.result.success).toBe(true);

    saveState.mockClear();
    recordDomainUsage.mockClear();
    emittedCompletions.length = 0;

    const second = await completeAgent(agentId, {
      success: false,
      exitCode: 143,
      errorAnalysis: { category: 'startup-failure' }
    });

    expect(second.result).toEqual(first.result);
    expect(second.result.success).toBe(true);
    expect(second.result.errorAnalysis).toBeUndefined();
    expect(second.completedAt).toBe(first.completedAt);
    expect(mockCosState.state.agents[agentId].result.success).toBe(true);

    // A no-op all the way out: no state write, no double budget charge, and no
    // second `agent:completed` (whose handler schedules the next task).
    expect(saveState).not.toHaveBeenCalled();
    expect(recordDomainUsage).not.toHaveBeenCalled();
    expect(emittedCompletions).toEqual([]);
    expect(mockCosState.state.stats).toEqual({ tasksCompleted: 1, errors: 0 });
  });

  it('does not re-run the completed-agent directory move on a duplicate', async () => {
    const agentId = 'agent-duplicate-archive';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' },
      output: []
    };

    const first = await completeAgent(agentId, { success: true, exitCode: 0 });
    const archivedMetadata = join(
      mockCosState.agentsDir, first.completedAt.slice(0, 10), agentId, 'metadata.json'
    );
    expect(existsSync(archivedMetadata)).toBe(true);

    // Late output can land back in the flat dir after the archive move. A second
    // completion must leave it alone rather than sweeping it into the bucket.
    const flatDir = join(mockCosState.agentsDir, agentId);
    await mkdir(flatDir, { recursive: true });
    await writeFile(join(flatDir, 'output.txt'), 'post-archive line\n');

    await completeAgent(agentId, { success: false, exitCode: 143 });

    expect(existsSync(join(flatDir, 'output.txt'))).toBe(true);
    const archived = JSON.parse(await readFile(archivedMetadata, 'utf8'));
    expect(archived.result.success).toBe(true);
    expect(archived.result.exitCode).toBe(0);
  });

  it('completes a still-paused agent (the guard is completed-only, not running-only)', async () => {
    const agentId = 'agent-paused-completion';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'paused',
      pausedAt: '2026-05-25T12:00:00.000Z',
      metadata: { taskType: 'scheduled' },
      output: []
    };

    const done = await completeAgent(agentId, { success: true, exitCode: 0 });

    expect(done.status).toBe('completed');
    expect(done.result.success).toBe(true);
  });

  it('completes a paused agent that resumed back to running', async () => {
    const agentId = 'agent-resumed-completion';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' },
      output: []
    };

    const paused = await updateAgent(agentId, { status: 'paused', pausedAt: '2026-05-25T12:00:00.000Z' });
    expect(paused.status).toBe('paused');

    const resumed = await updateAgent(agentId, { status: 'running' });
    expect(resumed.status).toBe('running');

    const done = await completeAgent(agentId, { success: true, exitCode: 0 });

    expect(done.status).toBe('completed');
    expect(done.result.success).toBe(true);
    expect(emittedCompletions).toHaveLength(1);
  });

  it('re-registering an id resets it to running so a retry can complete again', async () => {
    // Spawns mint a fresh `agent-<uuid>` id, so this only matters if one ever
    // collides — registerAgent must still hand back a completable record.
    const agentId = 'agent-reregistered';
    mockCosState.state.agents[agentId] = {
      id: agentId,
      status: 'running',
      metadata: { taskType: 'scheduled' },
      output: []
    };
    await completeAgent(agentId, { success: false, exitCode: 1 });

    const reregistered = await registerAgent(agentId, 'task-retry', { taskType: 'scheduled' });
    expect(reregistered.status).toBe('running');

    const done = await completeAgent(agentId, { success: true, exitCode: 0 });
    expect(done.result.success).toBe(true);
  });
});

describe('createAgentOutputBatcher', () => {
  const agentId = 'agent-batch';

  beforeEach(() => {
    saveState.mockClear();
    mockCosState.state = { agents: { [agentId]: { id: agentId, output: [] } } };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('coalesces many pushed lines into a single state write on flush', async () => {
    const batcher = createAgentOutputBatcher(agentId);
    batcher.push('line 1');
    batcher.push('line 2');
    batcher.push(['line 3', 'line 4']); // array push appends each line
    await batcher.flush();

    // Write-amplification guard: 4 lines, one load+save — not one per line.
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(mockCosState.state.agents[agentId].output.map((o) => o.line)).toEqual([
      'line 1', 'line 2', 'line 3', 'line 4'
    ]);
  });

  it('flush() is a no-op (no state write) when nothing was pushed', async () => {
    const batcher = createAgentOutputBatcher(agentId);
    await batcher.flush();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('captures lines pushed during an in-flight drain', async () => {
    const batcher = createAgentOutputBatcher(agentId);
    batcher.push('first');
    const flushing = batcher.flush();
    batcher.push('raced-in'); // arrives while the first drain is awaiting
    await flushing;
    await batcher.flush(); // second flush picks up the raced-in line

    expect(mockCosState.state.agents[agentId].output.map((o) => o.line)).toEqual([
      'first', 'raced-in'
    ]);
  });

  it('swallows + logs a state-write failure so flush() never rejects', async () => {
    saveState.mockRejectedValueOnce(new Error('disk full'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const batcher = createAgentOutputBatcher(agentId);
    batcher.push('doomed line');

    await expect(batcher.flush()).resolves.toBeUndefined();
    const logged = consoleSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' &&
        args[0].startsWith(`❌ agent ${agentId} output batch flush failed:`)
    );
    expect(logged).toBe(true);
  });
});
