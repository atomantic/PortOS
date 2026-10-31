/**
 * Shared mock factories and their mutable state for the held-checkout recovery
 * suites (heldCheckoutRecovery.test.js, heldCheckoutRecovery.receipts.test.js,
 * heldCheckoutRecovery.siblings.test.js). Not a test file itself.
 *
 * Each suite still writes its own one-line `vi.mock(...)` calls so Vitest's
 * hoister sees the literal module paths; the factories delegate here. This
 * module must not import any module those suites mock: a factory imports it
 * while that mocked module is still being resolved.
 */
import { realpathSync } from 'fs';
import { tmpdir } from 'os';
import { lazyTempDataRoot, makePathsProxy, ownFixtureWork } from '../lib/mockPathsDataRoot.js';

export const owned = ownFixtureWork();

// Fixed phase names and aggregates only: diagnostics must never expose fixture
// paths, Git arguments, captured bytes or an unbounded per-command transcript.
export const receiptTiming = {
  current: null,
  async run(phase, work) {
    const trace = this.current;
    if (!trace) return work();
    const started = performance.now();
    const row = trace.phases[phase] ??= { count: 0, ms: 0, maxMs: 0, active: 0 };
    row.active++;
    try { return await work(); }
    finally {
      const elapsed = performance.now() - started;
      row.active--;
      row.count++;
      row.ms += elapsed;
      row.maxMs = Math.max(row.maxMs, elapsed);
    }
  },
};

export const SYMLINKS = process.platform !== 'win32';
export const retirementFaults = { onRemove: null, onBranchDelete: null, scheduleWrites: 0, failScheduleWrite: null };
export const injected = { policies: [], schedule: null, app: null, fetchRemote: null, fetches: [], onBundle: null, onArchiveRef: null, onEvidence: null, onProof: null, proofFailures: [], onOtherFiles: null };

// Local branch deletion archives the common reflog using PATHS.cos, independently
// of the checkout archive's explicit cosDir option.
export const mockPaths = actual => makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('portos-held-branch-archives-') });

// Keep the real ownership queue, archive and destructive guards. Only time the
// existing callbacks, including queue wait in retirement-total's remainder.
export const mockClaimOwnershipState = actual => ({
  ...actual, retireWithUnlockedArchive: options => receiptTiming.run('retirement-total', () => actual.retireWithUnlockedArchive({
    ...options,
    admit: (...args) => receiptTiming.run('ownership-admission', () => options.admit(...args)),
    archive: (...args) => receiptTiming.run('preservation', () => options.archive(...args)),
    finish: (...args) => receiptTiming.run('destructive-settlement', () => options.finish(...args)),
  })),
});

export const mockExecGit = actual => ({ ...actual,
  execGitSafe: (args, cwd, options) => owned.run('git', () => actual.execGitSafe(args, cwd, options)),
  execGit: async (args, cwd, options) => {
    if (injected.onSnapshot && args[0] === 'ls-files' && args[1] === '-u') await injected.onSnapshot();
    // Pauses an archive mid-write, after its first snapshot and before its re-read.
    if (injected.onBundle && args.includes('bundle') && args.includes('create')) await injected.onBundle();
    if (injected.onUnlockedStatus && args[0] === 'status' && args[1] === '--porcelain') {
      injected.statusReads = (injected.statusReads || 0) + 1;
      if (injected.statusReads > 1) await injected.onUnlockedStatus();
    }
    if (injected.onEvidence && args[0] === 'bundle' && args[1] === 'verify') await injected.onEvidence();
    if (retirementFaults.onRemove && args[0] === 'worktree' && args[1] === 'remove') await retirementFaults.onRemove();
    if (retirementFaults.onBranchDelete && args[0] === 'push' && args.some(arg => arg.startsWith(':refs/heads/'))) await retirementFaults.onBranchDelete();
    if (args.includes('credential.helper=!gh auth git-credential') && args.includes('fetch')) {
      injected.fetches.push({ args, options });
      if (injected.fetchRemote) args = args.map(arg => arg === 'https://github.com/example/repo.git' ? injected.fetchRemote : arg);
    }
    try {
      const phase = options?.env?.GIT_NO_REPLACE_OBJECTS === '1' ? 'independent-object-proof'
        : args.includes('bundle') ? 'bundle' : 'other-git';
      const result = await receiptTiming.run(phase, () => owned.run('git', () => actual.execGit(args, cwd, options)));
      if (injected.onPreviewEvidence && args[0] === '--literal-pathspecs' && args[1] === 'diff') await injected.onPreviewEvidence();
      if (injected.onArchiveRef && args[0] === 'update-ref' && args[1]?.startsWith('refs/portos/archive/')) await injected.onArchiveRef();
      if (injected.onProof && args.includes('--bare') && options?.env?.GIT_NO_REPLACE_OBJECTS === '1') await injected.onProof();
      if (injected.onOtherFiles && args[0] === 'ls-files' && args[1] === '--others') {
        return { ...result, stdout: Buffer.from(injected.onOtherFiles(result.stdout.toString())) };
      }
      return result;
    }
    catch (error) {
      const phase = args.includes('unbundle') ? 'unbundle' : args.includes('fsck') ? 'fsck' : args.includes('--bare') ? 'init' : null;
      if (phase && options?.env?.GIT_NO_REPLACE_OBJECTS === '1') {
        // Persisted evidence hides child stderr; retain bounded fixture-only diagnostics.
        let message = String(error.message);
        for (const root of [cwd, tmpdir(), realpathSync(tmpdir())]) {
          message = message.split(root).join('<temp>').split(root.replaceAll('\\', '/')).join('<temp>');
        }
        injected.proofFailures.push({ phase, message: message.replace(/\s+/g, ' ').slice(0, 500) });
      }
      throw error;
    }
  } });

export const mockBranchCompletionPolicy = actual => ({
  ...actual, readBranchCompletionPolicies: async () => injected.policies,
  // Records the identity scope each policy evaluation received (#14458).
  reviewedRetirementPolicy: input => { injected.policyInputs?.push(input); return actual.reviewedRetirementPolicy(input); },
  readBranchCompletionHold: input => actual.readBranchCompletionHold(input, {
    readPolicies: async () => injected.policies,
  }),
});

export const mockTaskScheduleStore = actual => ({
  ...actual,
  loadSchedule: async () => injected.schedule,
  updateSchedule: mutate => receiptTiming.run('schedule-persistence', async () => {
    if (++retirementFaults.scheduleWrites === retirementFaults.failScheduleWrite) throw new Error('synthetic receipt persistence failure');
    return (await mutate(injected.schedule)).result;
  }),
});
