import { describe, it, expect, vi } from 'vitest';
import { reassignCollidingPorts, runStandardizeFlow } from './pm2Standardizer.js';

describe('reassignCollidingPorts', () => {
  it('moves a process off a taken port and rewrites both env.PORT and --port args', () => {
    // The reported bug: standardizer copied Vite's 5173/5174 even though 5173
    // was already listening.
    const processes = [
      { name: 'app-server', env: { NODE_ENV: 'development', PORT: 5173 } },
      { name: 'app-client', args: 'vite --host --port 5174', env: { VITE_PORT: 5174 } }
    ];
    const reassigned = reassignCollidingPorts(processes, [5173, 5174]);

    expect(processes[0].env.PORT).toBe(6000);
    expect(processes[1].env.VITE_PORT).toBe(6001);
    expect(processes[1].args).toBe('vite --host --port 6001');
    expect(reassigned).toEqual([[5173, 6000], [5174, 6001]]);
  });

  it('keeps the same new value when an old port appears in multiple places of one process', () => {
    const processes = [
      { name: 'client', args: 'vite --host --port 5173', env: { PORT: 5173, VITE_PORT: 5173 } }
    ];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(6000);
    expect(processes[0].env.VITE_PORT).toBe(6000);
    expect(processes[0].args).toBe('vite --host --port 6000');
  });

  it('leaves non-colliding ports untouched', () => {
    const processes = [{ name: 'srv', env: { PORT: 4321 } }];
    const reassigned = reassignCollidingPorts(processes, [5173, 5174]);
    expect(processes[0].env.PORT).toBe(4321);
    expect(reassigned).toEqual([]);
  });

  it('splits an intra-config duplicate so two processes never share one port', () => {
    const processes = [
      { name: 'a', env: { PORT: 3000 } },
      { name: 'b', env: { PORT: 3000 } }
    ];
    const reassigned = reassignCollidingPorts(processes, []);
    expect(processes[0].env.PORT).toBe(3000); // first keeps the free port
    expect(processes[1].env.PORT).toBe(6000); // duplicate bumped to a distinct one
    expect(reassigned).toEqual([[3000, 6000]]);
  });

  it('does not bump a later process off its valid port to satisfy an earlier collision', () => {
    // server (listed first) is on a taken port; client already holds a valid
    // 6000. The replacement for server must skip 6000 rather than steal it.
    const processes = [
      { name: 'server', env: { PORT: 5173 } },
      { name: 'client', env: { VITE_PORT: 6000 } }
    ];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[1].env.VITE_PORT).toBe(6000); // untouched
    expect(processes[0].env.PORT).toBe(6001); // skipped 6000
  });

  it('gives distinct ports to two processes that both reference the same taken port', () => {
    // The deterministic guarantee: even if the LLM puts both server PORT and
    // client VITE_PORT on 5173 (a taken default), the result must be collision-free.
    const processes = [
      { name: 'srv', env: { PORT: 5173 } },
      { name: 'cli', args: 'vite --host --port 5173', env: { VITE_PORT: 5173 } }
    ];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(6000);
    expect(processes[1].env.VITE_PORT).toBe(6001);
    expect(processes[1].args).toBe('vite --host --port 6001');
    expect(processes[0].env.PORT).not.toBe(processes[1].env.VITE_PORT);
  });

  it('never reassigns a colliding port onto a port another process legitimately kept', () => {
    // server keeps 6000 (free); client's 5173 is taken and must NOT be bumped to 6000.
    const processes = [
      { name: 'server', env: { PORT: 6000 } },
      { name: 'client', env: { VITE_PORT: 5173 } }
    ];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(6000);
    expect(processes[1].env.VITE_PORT).toBe(6001);
  });

  it('skips already-assigned ports when picking a free replacement', () => {
    // 6000 is taken, so the first reassignment lands on 6001, the next on 6002.
    const processes = [
      { name: 'a', env: { PORT: 5173 } },
      { name: 'b', env: { PORT: 5174 } }
    ];
    reassignCollidingPorts(processes, [5173, 5174, 6000]);
    expect(processes[0].env.PORT).toBe(6001);
    expect(processes[1].env.PORT).toBe(6002);
  });

  it('only treats *_PORT / PORT env keys as ports', () => {
    const processes = [{ name: 'a', env: { PORT: 5173, RETRIES: 5173 } }];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(6000);
    expect(processes[0].env.RETRIES).toBe(5173); // not a port key
  });
});

describe('runStandardizeFlow', () => {
  // A successful analysis plan shape (only the fields the flow reads).
  const okAnalysis = {
    success: true,
    proposedChanges: { processes: [{ name: 'srv' }], strayPorts: [{ file: '.env' }] }
  };

  it('runs analyze → backup → apply and returns a success outcome with the backup branch', async () => {
    const analyze = vi.fn().mockResolvedValue(okAnalysis);
    const backup = vi.fn().mockResolvedValue({ success: true, branch: 'portos-backup-123' });
    const apply = vi.fn().mockResolvedValue({ success: true, filesModified: ['ecosystem.config.cjs'], errors: [] });

    const outcome = await runStandardizeFlow('/repo', 'prov-1', { analyze, backup, apply });

    expect(analyze).toHaveBeenCalledWith('/repo', 'prov-1');
    // Step 3 must skip its own backup since step 2 already made one.
    expect(apply).toHaveBeenCalledWith('/repo', okAnalysis, { skipBackup: true });
    expect(outcome).toEqual({
      success: true,
      result: {
        backupBranch: 'portos-backup-123',
        filesModified: ['ecosystem.config.cjs'],
        processes: okAnalysis.proposedChanges.processes
      }
    });
  });

  it('emits ordered step + analyzed callbacks while it runs', async () => {
    const steps = [];
    const analyzed = vi.fn();
    await runStandardizeFlow('/repo', null, {
      onStep: ({ step, status }) => steps.push(`${step}:${status}`),
      onAnalyzed: analyzed,
      analyze: vi.fn().mockResolvedValue(okAnalysis),
      backup: vi.fn().mockResolvedValue({ success: true, branch: 'b1' }),
      apply: vi.fn().mockResolvedValue({ success: true, filesModified: [], errors: [] })
    });

    expect(steps).toEqual([
      'analyze:running', 'analyze:done',
      'backup:running', 'backup:done',
      'apply:running', 'apply:done'
    ]);
    expect(analyzed).toHaveBeenCalledWith({ plan: okAnalysis });
  });

  it('short-circuits with the analyze error and never backs up or applies', async () => {
    const backup = vi.fn();
    const apply = vi.fn();
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockResolvedValue({ success: false, error: 'No AI provider configured' }),
      backup,
      apply
    });
    expect(outcome).toEqual({ success: false, error: 'No AI provider configured' });
    expect(backup).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('aborts on a dirty worktree (DIRTY_WORKTREE) before applying', async () => {
    const apply = vi.fn();
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockResolvedValue(okAnalysis),
      backup: vi.fn().mockResolvedValue({ success: false, code: 'DIRTY_WORKTREE', reason: 'uncommitted changes' }),
      apply
    });
    expect(outcome).toEqual({ success: false, error: 'uncommitted changes' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('treats a non-git repo as a skipped backup and still applies (backupBranch null)', async () => {
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockResolvedValue(okAnalysis),
      backup: vi.fn().mockResolvedValue({ success: false, reason: 'Not a git repository' }),
      apply: vi.fn().mockResolvedValue({ success: true, filesModified: ['ecosystem.config.cjs'], errors: [] })
    });
    expect(outcome.success).toBe(true);
    expect(outcome.result.backupBranch).toBeNull();
  });

  it('returns the joined apply errors when applying fails', async () => {
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockResolvedValue(okAnalysis),
      backup: vi.fn().mockResolvedValue({ success: true, branch: 'b1' }),
      apply: vi.fn().mockResolvedValue({ success: false, filesModified: [], errors: ['disk full', 'oops'] })
    });
    expect(outcome).toEqual({ success: false, error: 'disk full, oops' });
  });

  it('surfaces a thrown analyze rejection as a failed outcome', async () => {
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockRejectedValue(new Error('boom')),
      backup: vi.fn(),
      apply: vi.fn()
    });
    expect(outcome).toEqual({ success: false, error: 'boom' });
  });
});
