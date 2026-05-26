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

import { getAgent } from './cosAgents.js';

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
