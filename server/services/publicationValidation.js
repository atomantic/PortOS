/** Fixed PortOS-only prepublication contract; never guesses commands for other apps. */
import { realpath, access } from 'node:fs/promises';
import { join } from 'node:path';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { execGit } from '../lib/execGit.js';
import { bufferedSpawn } from '../lib/bufferedSpawn.js';
import { doneSentinelCandidateNames } from '../lib/agentSentinel.js';
import { classifyWorktreeDirt } from './worktreeManager.js';

export async function validatePublication(context, deps = {}) {
  if (context.originalTask?.metadata?.app !== PORTOS_APP_ID) return { status: 'not-required' };
  const outcome = (reason, details = {}) => ({ status: 'blocked', reason, ...details, checkedAt: new Date().toISOString() });
  const git = deps.execGit || execGit;
  const run = deps.run || bufferedSpawn;
  let head;
  try {
    const getApp = deps.getApp || (await import('./apps.js')).getAppById;
    const app = await getApp(PORTOS_APP_ID);
    if (!app?.repoPath || await realpath(app.repoPath) !== await realpath(context.sourceWorkspace)) return outcome('source-mismatch');
    await access(join(context.worktreePath, 'scripts/pregate.js'));
    const read = async args => (await git(args, context.worktreePath)).stdout;
    const clean = async () => classifyWorktreeDirt(await read(['status', '--porcelain']), {
      ignoredPaths: doneSentinelCandidateNames(context.agentId),
    }).clean;
    head = (await read(['rev-parse', 'HEAD'])).trim();
    if (!await clean()) return outcome('uncommitted-work', { head });
    const result = await run(process.execPath, ['scripts/pregate.js'], {
      cwd: context.worktreePath, shell: false, timeoutMs: 30 * 60_000,
    });
    const details = { head, exitCode: result.code, signal: result.signal || null,
      outputTail: `${result.stdout || ''}\n${result.stderr || ''}`.slice(-4000) };
    if (result.timedOut) return outcome('timeout', details);
    if (result.error || result.signal || result.code === -1) return outcome('execution-failed', details);
    // A nonzero pregate may mean lint, setup or a test failed. Do not label it a test failure.
    if (!result.success) return outcome('pregate-nonzero', details);
    if ((await read(['rev-parse', 'HEAD'])).trim() !== head) return outcome('head-changed', details);
    if (!await clean()) return outcome('worktree-changed', details);
    return { status: 'passed', ...details, checkedAt: new Date().toISOString() };
  } catch (error) {
    return outcome('setup-failed', { head: head || null, error: String(error?.message || error).slice(0, 500) });
  }
}
