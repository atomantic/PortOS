import { existsSync } from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { pathExists } from '../../lib/fileUtils.js';
import { execGit } from '../../lib/execGit.js';
import { withGitMutationLifetime } from '../../lib/gitMutationLifetime.js';
import { ServerError } from '../../lib/errorHandler.js';

const checkoutMutations = new Map();
const checkoutMutationContext = new AsyncLocalStorage();

// Key resolution (realpath + ancestor walk) is async so it never blocks the event
// loop, but admission must still happen in call order: a caller that starts one
// mutation and immediately starts another has to see the first registered. Each
// call therefore joins this chain; resolving its key and registering it is one
// step, and the next call's resolution only begins after that registration.
let admissionTail = Promise.resolve();

async function resolveCheckoutKey(dir) {
  let key;
  try { key = await realpath(dir); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = resolve(dir);
  }
  // API paths may name a subdirectory or a symlink into the same checkout.
  for (let root = key; ; root = dirname(root)) {
    if (await pathExists(join(root, '.git'))) return root;
    if (dirname(root) === root) return key;
  }
}

// Existing writers register so an exclusive rebase/push cannot overlap them.
// Nested calls retain their own publication lifetime, even if they outlive a parent.
export async function withCheckoutMutation(dir, work, { exclusive = false } = {}) {
  const parent = checkoutMutationContext.getStore();
  const admission = admissionTail.then(async () => {
    const key = await resolveCheckoutKey(dir);
    const active = checkoutMutations.get(key);
    const inherited = parent?.active && parent.key === key && parent.state === active;
    if (!inherited && (active?.exclusive || (exclusive && active))) {
      throw new ServerError('A Git operation is already running for this checkout', { status: 409, code: 'GIT_BUSY' });
    }
    const state = active || { count: 0, exclusive };
    state.count++;
    checkoutMutations.set(key, state);
    return { key, state, context: { key, state, active: true } };
  });
  admissionTail = admission.catch(() => {});
  const { key, state, context } = await admission;
  try {
    return await withGitMutationLifetime(() => checkoutMutationContext.run(context, work));
  } finally {
    context.active = false;
    if (--state.count === 0) checkoutMutations.delete(key);
  }
}

/**
 * Sequencer state files a forced checkout does NOT clear, mapped to the command
 * that drops each. `--quit` rather than `--abort`: abort rewinds to the
 * pre-operation HEAD, which is the very state a reset is discarding, while
 * `--quit` removes the bookkeeping and leaves the tree the checkout just
 * restored alone. (`MERGE_HEAD` is absent here on purpose — a plain conflicted
 * merge IS cleared by `checkout --force`.)
 */
export const SEQUENCER_STATE = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert']
];

// Process-local lanes cannot exclude CLI actors or their conflict-resolution
// edits, even within a rebase this request started. Git has no conditional abort.
export const SHARED_REBASE_RECOVERY = 'Git operation state and any autostash were preserved. Inspect git status and save any conflict-resolution edits before explicitly continuing or aborting the operation.';

export function gitResultOutput(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

export function gitResultError(result, fallback) {
  return [result.stdout, result.stderr]
    .map(stream => (stream || '').trim())
    .filter(Boolean)
    .join('\n') || fallback;
}

export async function rebaseInProgress(dir) {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const res = await execGit(['rev-parse', '--git-path', name], dir, { ignoreExitCode: true });
    const gitPath = res.stdout?.trim();
    if (gitPath && existsSync(resolve(dir, gitPath))) return true;
  }
  return false;
}
