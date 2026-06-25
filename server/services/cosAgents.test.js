import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
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

import { getAgent, createAgentOutputBatcher, completeAgent } from './cosAgents.js';
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
