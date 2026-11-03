import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoScopedLegacyProcesses } from './maintenanceScopedProcesses.js';
import { appOperationResource } from './appOperations.js';

describe('workspace-scoped survivor detection', () => {
  const cli = [{ kind: 'cli-run', resource: 'run-1' }];
  const options = { data: '/install/data', loadRun: async () => ({ workspacePath: '/repos/work', providerId: 'example' }),
    loadProvider: async () => ({ command: 'codex' }), loadApp: async () => null, selfPid: 1 };
  it('detects a detached CLI without the run ID in its command line', async () => {
    const processes = [{ pid: 2, state: 'S', command: '/usr/local/bin/codex exec' }];
    await expect(assertNoScopedLegacyProcesses(cli, processes, { ...options, probeCwds: async () => new Map([[2, '/repos/work']]) }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    await expect(assertNoScopedLegacyProcesses(cli, processes, { ...options, probeCwds: async () => new Map([[2, '/repos/unrelated']]) }))
      .resolves.toEqual([]);
  });
  it('detects a Grok media child by its saved scratch directory when its ID is absent from argv', async () => {
    const id = '12345678-1234-4234-8234-123456789abc';
    await expect(assertNoScopedLegacyProcesses([{ kind: 'media', resource: id }],
      [{ pid: 2, state: 'S', command: 'grok -p -' }], { ...options,
        probeCwds: async () => new Map([[2, join(tmpdir(), `portos-grok-video-${id}`)]]) }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it('detects an app update child in its checkout while ignoring another repository', async () => {
    const processes = [{ pid: 3, state: 'S', command: '/usr/bin/git fetch origin' }];
    const ops = [{ kind: 'app-operation', resource: 'my-app' }];
    const common = { ...options, loadApp: async () => ({ repoPath: '/repos/app' }) };
    await expect(assertNoScopedLegacyProcesses(ops, processes, { ...common, probeCwds: async () => new Map([[3, '/repos/app/src']]) }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    await expect(assertNoScopedLegacyProcesses(ops, processes, { ...common, probeCwds: async () => new Map([[3, '/repos/unrelated']]) }))
      .resolves.toEqual([]);
  });
  it('detects a detached deploy script in its registered checkout', async () => {
    const ops = [{ kind: 'app-operation', resource: 'my-app' }];
    await expect(assertNoScopedLegacyProcesses(ops, [{ pid: 3, state: 'S', command: '/bin/bash deploy.sh --ios' }],
      { ...options, loadApp: async () => ({ repoPath: '/repos/app' }), probeCwds: async () => new Map([[3, '/repos/app']]) }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it.skipIf(process.platform === 'win32')('resolves long symlinked and relative standardization workspaces', async () => {
    const root = mkdtempSync(join(tmpdir(), 'long-workspace-'));
    try {
      const workspace = join(root, ...Array(4).fill('long-directory-name-'.repeat(4)));
      mkdirSync(workspace, { recursive: true });
      const alias = join(root, 'alias');
      symlinkSync(workspace, alias);
      const operations = [{ kind: 'app-operation', resource: appOperationResource(alias) }];
      expect(operations[0].resource).toMatch(/^path-sha256-/);
      await expect(assertNoScopedLegacyProcesses(operations, [{ pid: 3, state: 'S', command: 'git status' }],
        { ...options, probeCwds: async () => new Map([[3, workspace]]) })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
      expect(appOperationResource('.')).toMatch(/^\//);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('preserves unknown legacy outcomes when no metadata or matching process is available', async () => {
    await expect(assertNoScopedLegacyProcesses(cli, [{ pid: 2, state: 'S', command: 'codex' }],
      { ...options, loadRun: async () => null, probeCwds: async () => new Map() })).resolves.toEqual(['run-workspace-unavailable']);
  });
  it('detects the configured scheduled shell command in the PortOS checkout', async () => {
    const processes = [{ pid: 4, state: 'S', command: '/usr/bin/git status' }];
    const ops = [{ kind: 'shell-job', resource: 'job-1' }];
    await expect(assertNoScopedLegacyProcesses(ops, processes, { ...options, codeRoot: '/repos/portos',
      loadJob: async () => ({ command: 'git status' }), probeCwds: async () => new Map([[4, '/repos/portos']]) }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it('detects a no-PID agent child in the agent workspace', async () => {
    const ops = [{ kind: 'agent', resource: 'agent-1' }];
    const processes = [{ pid: 5, state: 'S', command: 'codex exec' }];
    await expect(assertNoScopedLegacyProcesses(ops, processes, { ...options,
      loadAgent: async () => ({ metadata: { workspacePath: '/repos/agent' } }),
      probeCwds: async () => new Map([[5, '/repos/agent']]) })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it('detects an agent setup git process before the task is identified as an agent', async () => {
    const ops = [{ kind: 'agent', resource: 'task-1' }];
    const processes = [{ pid: 9, state: 'S', command: 'git fetch origin' }];
    await expect(assertNoScopedLegacyProcesses(ops, processes, { ...options,
      loadAgent: async () => ({ id: 'task-1', metadata: { app: 'my-app' } }),
      loadApp: async () => ({ repoPath: '/repos/app' }), probeCwds: async () => new Map([[9, '/repos/app']]) }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it.each(['opencode run', 'pi --print', 'cursor-agent -p'])('detects the supported provider command %s', async command => {
    await expect(assertNoScopedLegacyProcesses(cli, [{ pid: 6, state: 'S', command }], { ...options,
      probeCwds: async () => new Map([[6, '/repos/work']]) })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it('detects a configured provider executable outside the shell-job allowlist', async () => {
    await expect(assertNoScopedLegacyProcesses(cli, [{ pid: 8, state: 'S', command: '/opt/bin/custom-harness --stdin' }], {
      ...options, loadRun: async () => ({ workspacePath: '/repos/work', providerId: 'custom' }),
      loadProvider: async () => ({ command: '/opt/bin/custom-harness' }), probeCwds: async () => new Map([[8, '/repos/work']]),
    })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it('records when a legacy custom provider command cannot be inspected', async () => {
    await expect(assertNoScopedLegacyProcesses(cli, [], { ...options,
      loadRun: async () => ({ workspacePath: '/repos/work', providerId: 'removed-provider' }),
      loadProvider: async () => { throw new Error('provider unavailable'); },
    })).resolves.toEqual(['provider-command-unavailable']);
    await expect(assertNoScopedLegacyProcesses(cli, [], { ...options,
      loadRun: async () => ({ workspacePath: '/repos/work' }),
    })).resolves.toEqual(['provider-command-unavailable']);
  });
  it.each(['/bin/bash /repos/app/update.sh', 'powershell.exe -File C:\\repos\\app\\update.ps1', 'node scripts/update.js'])
  ('detects a managed update child: %s', async command => {
    const ops = [{ kind: 'app-operation', resource: 'app-1' }];
    await expect(assertNoScopedLegacyProcesses(ops, [{ pid: 7, state: 'S', command }], { ...options,
      loadApp: async () => ({ repoPath: '/repos/app', updateCommand: 'node scripts/update.js' }),
      probeCwds: async () => new Map([[7, '/repos/app']]) })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it('recognizes a Windows orphan by its recorded parent without a cwd', async () => {
    const ops = [{ kind: 'cli-run', resource: 'run-1', pid: 100, startedAt: '2026-11-01T00:00:00Z' }];
    const processes = [{ pid: 101, ppid: 100, state: 'S', startedAt: Date.parse('2026-11-01T00:00:01Z'), command: 'codex exec' }];
    await expect(assertNoScopedLegacyProcesses(ops, processes, { ...options, probeCwds: async () => new Map() }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it('ignores an unrelated CLI that predates the operation', async () => {
    const ops = [{ kind: 'cli-run', resource: 'run-1', pid: 100, startedAt: '2026-11-02T00:00:00Z' }];
    const processes = [{ pid: 101, state: 'S', startedAt: Date.parse('2026-11-01T00:00:00Z'), command: 'codex exec' }];
    await expect(assertNoScopedLegacyProcesses(ops, processes, { ...options,
      probeCwds: async () => new Map([[101, '/repos/work']]) })).resolves.toEqual([]);
  });
  it('does not count the exact waiting updater as an app-operation survivor', async () => {
    const ops = [{ kind: 'app-operation', resource: 'portos-default', pid: 100, startedAt: '2026-11-01T00:00:00Z' }];
    const processes = [{ pid: 123, state: 'S', command: 'npm update /repos/portos' }];
    await expect(assertNoScopedLegacyProcesses(ops, processes, { ...options, updatePid: 123,
      loadApp: async () => ({ repoPath: '/repos/portos' }), probeCwds: async () => new Map([[123, '/repos/portos']]) }))
      .resolves.toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('matches a workspace through a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scoped-process-'));
    try {
      const workspace = join(root, 'workspace');
      const alias = join(root, 'alias');
      mkdirSync(workspace);
      symlinkSync(workspace, alias);
      await expect(assertNoScopedLegacyProcesses(cli, [{ pid: 2, state: 'S', command: 'codex exec' }], {
        ...options, loadRun: async () => ({ workspacePath: alias }), probeCwds: async () => new Map([[2, workspace]]),
      })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('records an unavailable cwd probe without inventing a matching process', async () => {
    await expect(assertNoScopedLegacyProcesses(cli, [{ pid: 2, state: 'S', command: 'codex exec' }],
      { ...options, probeCwds: async () => { throw new Error('lsof unavailable'); } }))
      .resolves.toEqual(['workspace-cwd-unavailable', 'workspace-cwd-partial']);
  });
});
