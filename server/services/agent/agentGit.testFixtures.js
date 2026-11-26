import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { execGit } from '../../lib/execGit.js';
import { destroyGitSandbox, makeGitSandbox } from '../../lib/gitTestRepo.js';

export function useAgentGitSandbox() {
  const fixture = { forgeLookupAvailable: true };
  let scratch;

  beforeAll(async () => {
    const sandbox = await makeGitSandbox({ origin: true });
    scratch = sandbox.scratch;
    const install = await realpath(scratch);
    fixture.repo = await realpath(sandbox.repo);
    await execGit(['remote', 'set-head', 'origin', 'main'], fixture.repo);

    // Load the install-path constants after the pin. Resolve the write guard's
    // protected root first so it continues to protect the real install.
    vi.resetModules();
    const { isInsideRealDataRoot } = await import('../../lib/testDataIsolation.js');
    expect(isInsideRealDataRoot(install)).toBe(false);
    await writeFile(join(install, '.portos-disposable-root'), '');
    vi.stubEnv('PORTOS_DATA_ROOT', install);

    // A local bare origin handles Git transport. Only the external CLI's
    // branch lookup is simulated, using the real spawn/stream contract.
    vi.doMock('../../lib/childProcess.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        spawn(command, args, options) {
          if (command !== 'gh' && command !== 'glab') return actual.spawn(command, args, options);
          if (command !== 'gh' || args[0] !== 'pr' || args[1] !== 'list' || !args.includes('--head')) {
            throw new Error(`Unexpected forge command: ${command} ${args.slice(0, 2).join(' ')}`);
          }
          const script = fixture.forgeLookupAvailable ? 'process.stdout.write("[]")' : 'process.exitCode = 1';
          return actual.spawn(process.execPath, ['-e', script], options);
        },
      };
    });

    const { PATHS } = await import('../../lib/paths.js');
    expect(PATHS.installRoot).toBe(install);
  });

  afterAll(async () => {
    vi.doUnmock('../../lib/childProcess.js');
    vi.unstubAllEnvs();
    await destroyGitSandbox(scratch);
  });

  return fixture;
}

export async function registerGitAgent(repo, agentId, task) {
  const { createWorktree } = await import('../worktreeManager.js');
  const { registerAgent } = await import('../cos/cosAgentLifecycle.js');
  const { worktreePath, branchName, instanceId } = await createWorktree(agentId, repo, task.id, {
    baseBranch: 'main', linkDependencies: false,
  });

  await registerAgent(agentId, task.id, {
    isWorktree: true, sourceWorkspace: repo, workspacePath: await realpath(worktreePath),
    worktreeBranch: branchName, instanceId,
  });
  return { worktreePath, branchName };
}
