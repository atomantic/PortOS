/**
 * Explicit initialized-private-module retirement. A merged, clean checkout is
 * removed at its original path. An unmerged or dirty checkout stays there.
 * A reviewed locked publisher additionally preserves an archive and a durable
 * lock-transition journal before removal. Interrupted transitions retain the
 * repository admission cut for recovery.
 */
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';
import { spawn } from '../lib/childProcess.js';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, opendir, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { type as hostOsType } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../lib/paths.js';
import { execGit } from '../lib/execGit.js';
import { assertNotRealDataWrite } from '../lib/testDataIsolation.js';
import { withClaimOwnershipLock } from './cosClaimOwnershipState.js';
import { SPOTLIGHT_MARKER } from '../../scripts/lib/spotlightExclude.js';

const helper = fileURLToPath(new URL('../../scripts/lib/initialized_checkout_archive.py', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw new Error(reason); };
const sameRelease = (a = {}, b = {}) => ['path', 'head', 'branch', 'locked', 'lockReason'].every(key => (a[key] ?? null) === (b[key] ?? null));
const transactionRoot = () => join(PATHS.cos, 'initialized-checkout-retirements');

/** Native helper holds its own flock until the actual child exits. */
export function _runInitializedCheckoutNative(input, { keepOpen = false, beforeMutation } = {}) {
  if (process.platform !== 'darwin') return Promise.reject(new Error('retirement-platform-unsupported'));
  return new Promise((resolve, reject) => {
    const permit = beforeMutation ? randomUUID() : null;
    if (permit && (keepOpen || input.command !== 'resume-quarantine')) return reject(new Error('retirement-native-permit-command-invalid'));
    let permissionRequested = false;
    const child = spawn('/usr/bin/python3', [helper], { stdio: ['pipe', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PYTHONDONTWRITEBYTECODE: '1',
    } });
    let output = '';
    let failure = null;
    let acquired = false;
    let closed = false;
    let escalation;
    const stop = error => {
      failure ||= error;
      child.kill('SIGTERM');
      escalation ||= setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const timer = setTimeout(() => stop(new Error('retirement-native-timeout')), keepOpen ? 30_000 : 20 * 60_000);
    const exited = new Promise(done => child.once('close', done));
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      if (keepOpen && acquired) return;
      if (failure) return reject(failure);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.ok !== true) throw new Error(result.reason || 'retirement-native-failed');
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdout.on('data', data => {
      output += data;
      if (output.length > 4 * 1024 * 1024) return stop(new Error('retirement-native-output-limit'));
      if (permit && !permissionRequested && output.includes('\n')) {
        const newline = output.indexOf('\n');
        let ready;
        try { ready = JSON.parse(output.slice(0, newline)); } catch { return stop(new Error('retirement-native-permit-invalid')); }
        // A refused native verification may finish without requesting permission.
        if (ready.ok === false) return;
        if (ready.mutationReady !== permit || ready.part !== 'administration'
          || Object.keys(ready).length !== 2) return stop(new Error('retirement-native-permit-invalid'));
        permissionRequested = true;
        output = output.slice(newline + 1);
        Promise.resolve().then(beforeMutation).then(() => {
          if (closed || failure) return;
          child.stdin.end(`${JSON.stringify({ mutationPermit: permit, allow: true })}\n`);
        }).catch(stop);
      }
      if (keepOpen && !acquired && output.includes('\n')) {
        try {
          const result = JSON.parse(output.slice(0, output.indexOf('\n')));
          if (!result.ok) return stop(new Error(result.reason || 'retirement-executor-busy'));
          acquired = true;
          clearTimeout(timer);
          resolve({ assertHeld: () => { if (closed) fail('retirement-executor-lost'); },
            release: async () => { child.stdin.end(); await exited; } });
        } catch (error) { stop(error); }
      }
    });
    // Metadata and native diagnostics stay out of public logs.
    child.stderr.resume();
    child.stdin.on('error', error => { failure ||= error; });
    child.stdin.write(`${JSON.stringify(permit ? { ...input, mutationPermit: permit } : input)}\n`);
    if (!keepOpen && !permit) child.stdin.end();
  });
}

// Native execution remains Darwin-only. Mocked workflow tests may run on
// Windows, where POSIX modes and opening directories for fsync are unsupported.
async function syncDirectory(path) {
  if (hostOsType() === 'Windows_NT') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function privateDirectory(path, create = false) {
  assertNotRealDataWrite(path, 'initialized checkout recovery');
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (hostOsType() !== 'Windows_NT' && (info.mode & 0o777) !== 0o700)) fail('retirement-journal-directory-unsafe');
}

async function appendStep(directory, state, phase, patch = {}) {
  await privateDirectory(directory);
  const next = { ...state, ...patch, phase, sequence: (state.sequence ?? -1) + 1,
    previous: state.sequence == null ? null : hash(state) };
  const name = `${String(next.sequence).padStart(6, '0')}.json`;
  const staged = join(directory, `.${name}.${randomUUID()}.staging`);
  const file = await open(staged, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(next)}\n`); await file.sync(); }
  finally { await file.close(); }
  // A partial write must never occupy the next committed sequence. Hardlink
  // publication is atomic and refuses an existing name on every supported
  // test platform. Retain staging names, including interrupted rows, as evidence.
  await link(staged, join(directory, name));
  await syncDirectory(directory);
  return next;
}

async function readJournal(directory, { bounded = false, budget } = {}) {
  await privateDirectory(directory);
  const names = [];
  if (bounded) {
    const listing = await opendir(directory);
    for await (const entry of listing) {
      if (names.length >= 1024) fail('retirement-journal-budget-exceeded');
      names.push(entry.name);
    }
  } else names.push(...await readdir(directory));
  const files = names.filter(name => /^\d{6}\.json$/.test(name)).sort();
  if (bounded && files.length > 128) fail('retirement-journal-budget-exceeded');
  let previous = null, bytes = 0;
  for (const [sequence, name] of files.entries()) {
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || (hostOsType() !== 'Windows_NT' && (info.mode & 0o777) !== 0o600)) fail('retirement-journal-unsafe');
    bytes += info.size;
    if (budget) { budget.remaining -= info.size; if (budget.remaining < 0) fail('retirement-discovery-budget-exceeded'); }
    if (bounded && (info.size > 16 * 1024 * 1024 || bytes > 64 * 1024 * 1024)) fail('retirement-journal-budget-exceeded');
    const row = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (bounded && previous && ['id', 'appId', 'repoPath', 'release', 'review'].some(key => JSON.stringify(row[key]) !== JSON.stringify(previous[key]))) fail('retirement-journal-identity-changed');
    if (row.version !== 1 || row.sequence !== sequence || row.previous !== (previous ? hash(previous) : null)) fail('retirement-journal-invalid');
    previous = row;
  }
  if (!previous) fail('retirement-journal-missing');
  return previous;
}

async function defaultContext(appId, release) {
  const [{ getAppById }, { getBranchReconcileOutcome }] = await Promise.all([import('./apps.js'), import('./branchReconcileOutcome.js')]);
  const app = await getAppById(appId);
  if (!app?.repoPath) fail('app-not-found');
  if (release) {
    const inventory = await getBranchReconcileOutcome(appId);
    if (!inventory?.remaining?.some(entry => sameRelease(entry, release))) fail('release-not-in-inventory');
  }
  return { repoPath: app.repoPath, forgeAccount: app.forgeAccount ?? null };
}

/** Factory allows workflow tests to replace native IO and forge/network boundaries. */
export function _createInitializedCheckoutRecovery(deps = {}) {
  const native = deps.native || _runInitializedCheckoutNative;
  const root = deps.root || transactionRoot;
  const context = deps.context || defaultContext;
  const fenced = deps.fenced || withClaimOwnershipLock;
  const ownership = deps.ownership || (async input => (await import('./heldCheckoutRecovery.js')).inspectCheckoutRetirementOwnership(input));
  const admission = async () => deps.admission || await import('../lib/checkoutRetirementAdmission.js');
  const forge = deps.forge || (async (ctx, release, prUrl) => (await import('./heldCheckoutReview.js')).readRetirementForgeEvidence(
    ctx.repoPath, release.branch, prUrl, { forgeAccount: ctx.forgeAccount, exactAliasHead: release.head, exactDeliveredHead: release.head }));
  const comparison = deps.comparison || (async (ctx, release, prUrl, snapshot, policy, forgeFacts) => {
    const { buildCheckoutRetirementReview } = await import('./heldCheckoutReview.js');
    const run = () => buildCheckoutRetirementReview({ repoPath: ctx.repoPath, release, prUrl,
      contentFingerprint: snapshot.fingerprint, administrationFingerprint: snapshot.administrationFingerprint, policy },
    { readForge: async () => forgeFacts });
    try {
      return await run();
    } catch (error) {
      if (error?.message === 'retirement-local-objects-missing') {
        const { fetchRetirementProofObjects } = await import('./heldCheckoutRecovery.js');
        const fetched = await (deps.fetchProofObjects || fetchRetirementProofObjects)(
          ctx.repoPath, release, prUrl, null,
          { forgeAccount: ctx.forgeAccount, readForge: async () => forgeFacts, exactAliasHead: release.head }
        );
        if (fetched?.ok) return run();
      }
      throw error;
    }
  });
  const ensureOwner = async (ctx, release, registration = true, reviewed = null) => {
    const input = { repoPath: ctx.repoPath, release, registration };
    const result = await ownership(input);
    if (result.ok) return result.policy;
    if (result.reason !== 'retirement-policy-not-legacy-completed' || !reviewed?.checkoutIncarnation) fail(result.reason);
    const facts = await forge(ctx, release, reviewed.forge.prUrl);
    const continued = await ownership({ ...input, forgeAccount: ctx.forgeAccount, reviewIdentity: {
      checkoutPath: release.path, tip: release.head, prUrl: facts.prUrl, verifiedPrHead: facts.prHead,
      retirementForge: facts, checkoutIncarnation: reviewed.checkoutIncarnation,
    } });
    if (!continued.ok || !continued.policy?.policies?.some(row => row.continuedDelivery)) fail(continued.reason || result.reason);
    return continued.policy;
  };
  const makeReview = async ({ appId, release, prUrl, wholeCheckout = false }) => {
    const ctx = await context(appId, release);
    let checkoutIncarnation;
    const policy = await ensureOwner(ctx, release).catch(async error => {
      if (error.message !== 'retirement-policy-not-legacy-completed') throw error;
      const read = deps.readCompletedIdentity || (await import('./completedCheckoutEvidence.js')).readCompletedCheckoutIdentity;
      const generation = await read({ repoPath: ctx.repoPath, ...release, allowLocked: release.locked === true }).catch(() => null);
      if (!generation) throw error;
      checkoutIncarnation = generation.incarnation;
      return ensureOwner(ctx, release, true, { forge: { prUrl }, checkoutIncarnation });
    });
    const snapshot = await native({ command: 'inspect', repoPath: ctx.repoPath, release, requireOwnership: true, retirementOnly: true,
      ...(wholeCheckout && { wholeCheckout: true }), ...(release.locked && { lockTransition: true }) });
    const facts = await forge(ctx, release, prUrl);
    const base = await comparison(ctx, release, prUrl, snapshot, policy, facts);
    const checkoutIdentity = await readRetirementCheckoutIdentity(release.path);
    if (release.checkoutIdentity && release.checkoutIdentity !== checkoutIdentity) fail('checkout-identity-changed');
    const evidence = { ...base, mode: wholeCheckout ? 'whole-checkout' : 'initialized-private-modules', snapshot,
      ...(checkoutIdentity && { checkoutIdentity }), ...(checkoutIncarnation && { checkoutIncarnation }) };
    delete evidence.digest;
    return { ctx, review: { digest: hash(evidence), ...evidence } };
  };
  const review = input => fenced(async () => {
    const ctx = await context(input.appId, input.release);
    return (await admission()).withCheckoutPublication(ctx.repoPath, async () => ({ ok: true, ...(await makeReview(input)) }));
  }).then(({ review: result }) => ({ ok: true, review: result }), error => ({ ok: false, reason: error.message }));
  const assertReview = (current, accepted) => {
    if (current.digest !== accepted.digest) fail('retirement-review-changed');
    if (current.comparison.disposition === 'review-supersession' && accepted.acceptSuperseded !== true) fail('retirement-supersession-not-accepted');
  };
  const location = id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail('retirement-transaction-invalid');
    return join(root(), id);
  };
  const retire = input => (async () => {
    // Retention performs its own evidence reads and must run before taking the
    // ownership fence; the reviewed retirement below rechecks all ownership.
    const ctx = await context(input.appId, input.release);
    const retain = deps.retainReleaseSynchronizationReview || (await import('./releaseSynchronization.js')).retainReleaseSynchronizationReview;
    const retained = await retain({ ...input.release, repoPath: ctx.repoPath,
      checkoutIdentity: input.release.checkoutIdentity || await readRetirementCheckoutIdentity(input.release.path) }).catch(() => false);
    if (!retained) return { ok: false, reason: 'release-sync-local-review-unretained' };
    const prepareLegacy = deps.prepareLegacyReleaseRetirement || (await import('./releaseSynchronization.js')).prepareLegacyReleaseRetirement;
    const archiveProofs = await prepareLegacy({ ...input.release, repoPath: ctx.repoPath,
      checkoutIdentity: input.release.checkoutIdentity || await readRetirementCheckoutIdentity(input.release.path) }).catch(() => null);
    if (!archiveProofs) return { ok: false, reason: 'legacy-release-recovery-changed' };
    return fenced(async () => {
      const prepared = await makeReview({ ...input, prUrl: input.review.prUrl });
      assertReview(prepared.review, input.review);
      const { ctx } = prepared;
      if (prepared.review.comparison?.disposition !== 'integrated') return { ok: false, reason: 'not-merged-on-recheck' };
      // Captured by makeReview before removal. A later lstat of a deleted .git is null.
      const checkoutIdentity = prepared.review.checkoutIdentity || input.release.checkoutIdentity || null;
      const runGit = deps.execGit || execGit;
      const status = await runGit(['status', '--porcelain'], input.release.path,
        { ignoreExitCode: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).catch(() => null);
      if (!status || status.exitCode !== 0) return { ok: false, reason: 'worktree-status-unavailable' };
      if (String(status.stdout || '').trim()) return { ok: false, reason: 'worktree-dirty' };
      const { forgeValidationEvidence } = await import('./heldCheckoutRecovery.js');
      const legacyCurrent = deps.validateLegacyReleaseRetirement || (await import('./releaseSynchronization.js')).validateLegacyReleaseRetirement;
      if (!await legacyCurrent({ ...input.release, repoPath: ctx.repoPath, checkoutIdentity }, { archiveProofs }).catch(() => false)) {
        return { ok: false, reason: 'legacy-release-recovery-changed' };
      }
      const validationEvidence = forgeValidationEvidence(prepared.review);
      if (input.release.locked) return retireLocked({ input, prepared, ctx, checkoutIdentity, archiveProofs, validationEvidence, runGit });
      const removed = await runGit(['worktree', 'remove', '--force', input.release.path], ctx.repoPath, { ignoreExitCode: true }).catch(() => null);
      if (!removed || removed.exitCode !== 0) {
        return { ok: false, reason: 'checkout-not-removed' };
      }
      let branchDeleted = false;
      if (input.release.branch) {
        const deleteRef = deps.deleteRef || (await import('./worktreeManager.js')).deleteCompletedLocalBranch;
        branchDeleted = await deleteRef(ctx.repoPath, input.release.branch, input.release.head, {}) === true;
      }
      const record = deps.recordRetirement || (await import('./branchReconcileOutcome.js')).recordHeldCheckoutRetirement;
      let outcome = null;
      try {
        outcome = await record(input.appId, {
          path: input.release.path, branch: input.release.branch ?? null, head: input.release.head, branchDeleted,
          ...(checkoutIdentity && { checkoutIdentity }),
          ...(validationEvidence && { validationEvidence }),
        });
      } catch {
        return { ok: false, reason: 'retirement-receipt-unverified', branchDeleted };
      }
      const wantedBranch = input.release.branch ?? null;
      const recorded = outcome?.retired?.some(row => (row.path || null) === (input.release.path || null)
        && (row.branch ?? null) === wantedBranch && row.head === input.release.head
        && row.branchDeleted === true && row.archiveDir == null
        && (!checkoutIdentity || row.checkoutIdentity === checkoutIdentity)
        && (!validationEvidence || row.validationEvidence?.prHead === validationEvidence.prHead)) === true;
      if (!recorded) return { ok: false, reason: 'retirement-receipt-unverified', branchDeleted };
      return { ok: true, branchDeleted, ...(validationEvidence && { validationEvidence }) };
    });
  })().catch(error => ({ ok: false, reason: error.message }));

  // The durable cut and intent precede unlocking. Any uncertain transition is
  // retained for inspection; restart never guesses that a Git child completed.
  const retireLocked = async ({ input, prepared, ctx, checkoutIdentity, archiveProofs, validationEvidence, runGit }) => {
    if (!checkoutIdentity || !prepared.review.snapshot.lockTransitionFingerprint || !validationEvidence) return { ok: false, reason: 'locked-retirement-evidence-unavailable' };
    const validatePublisher = deps.validateLockedPublisherRetirement || (await import('./releaseSynchronization.js')).validateLockedPublisherRetirement;
    const scoped = { ...input.release, repoPath: ctx.repoPath, checkoutIdentity };
    if (!await validatePublisher(scoped)) return { ok: false, reason: 'locked-publisher-unverified' };
    const id = randomUUID(), directory = location(id), gate = await admission();
    let executor;
    try {
      await privateDirectory(root(), true);
      await syncDirectory(dirname(root()));
      await mkdir(directory, { mode: 0o700 });
      await syncDirectory(root());
      let state = await appendStep(directory, { version: 1, id, appId: input.appId, repoPath: ctx.repoPath,
        release: input.release, review: prepared.review }, 'locked-intent');
      executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
      const reservation = await gate.reserveCheckoutRetirement(ctx.repoPath, id);
      state = await appendStep(directory, state, 'locked-reserved', { reservation });
      return await gate.withCheckoutReservation(reservation, async () => {
        executor.assertHeld();
        const fresh = await makeReview({ ...input, prUrl: input.review.prUrl });
        assertReview(fresh.review, input.review);
        if (fresh.review.checkoutIdentity !== checkoutIdentity || !await validatePublisher(scoped)) fail('locked-publisher-unverified');
        const legacyCurrent = deps.validateLegacyReleaseRetirement || (await import('./releaseSynchronization.js')).validateLegacyReleaseRetirement;
        if (!await legacyCurrent(scoped, { archiveProofs })) fail('legacy-release-recovery-changed');
        // A clean submodule may still contain private refs and objects. Preserve
        // its complete administration and working bytes before any unlock.
        const inspection = await native({ command: 'inspect', repoPath: ctx.repoPath, release: input.release,
          requireOwnership: true, ...(input.wholeCheckout && { wholeCheckout: true }) });
        if (inspection.administrationFingerprint !== fresh.review.snapshot.administrationFingerprint
          || JSON.stringify(inspection.identity) !== JSON.stringify(fresh.review.snapshot.identity)) fail('retirement-review-changed');
        const proof = await native({ command: 'preserve', repoPath: ctx.repoPath, release: input.release,
          transactionDir: directory, expected: inspection, requireOwnership: true,
          ...(input.wholeCheckout && { wholeCheckout: true }) });
        if (!/^[a-f0-9]{64}$/.test(proof.manifestSha256 || '')) fail('preservation-proof-unbound');
        state = await appendStep(directory, state, 'locked-preserved', { proof });
        const preserved = await makeReview({ ...input, prUrl: input.review.prUrl });
        assertReview(preserved.review, input.review);
        if (!await validatePublisher(scoped) || !await legacyCurrent(scoped, { archiveProofs })) fail('retirement-evidence-changed');
        const archive = await native({ command: 'verify', transactionDir: directory, manifestSha256: proof.manifestSha256, mode: 'standalone' });
        if (archive.verified !== true || archive.standalone !== true) fail('preservation-proof-unverified');
        assertReview((await makeReview({ ...input, prUrl: input.review.prUrl })).review, input.review);
        if (!await validatePublisher(scoped) || !await legacyCurrent(scoped, { archiveProofs })) fail('retirement-evidence-changed');
        state = await appendStep(directory, state, 'locked-unlock-intent');
        executor.assertHeld();
        const unlock = await runGit(['worktree', 'unlock', input.release.path], ctx.repoPath, { ignoreExitCode: true });
        if (unlock.exitCode !== 0) fail('worktree-unlock-uncertain');
        state = await appendStep(directory, state, 'locked-unlocked');
        const observation = await native({ command: 'inspect', repoPath: ctx.repoPath, release: input.release,
          requireOwnership: true, retirementOnly: true, lockTransition: true, expectUnlocked: true,
          ...(input.wholeCheckout && { wholeCheckout: true }) });
        if (observation.lockTransitionFingerprint !== fresh.review.snapshot.lockTransitionFingerprint
          || await readRetirementCheckoutIdentity(input.release.path) !== checkoutIdentity) fail('retirement-review-changed');
        const unlocked = { ...input.release, locked: false, lockReason: null };
        if (JSON.stringify(await ensureOwner(ctx, unlocked, true, fresh.review)) !== JSON.stringify(fresh.review.policy)
          || JSON.stringify(await forge(ctx, input.release, input.review.prUrl)) !== JSON.stringify(fresh.review.forge)
          || !await validatePublisher(scoped) || !await legacyCurrent(scoped, { unlocked: true, archiveProofs })) fail('retirement-evidence-changed');
        const verifiedArchive = await native({ command: 'verify', transactionDir: directory, manifestSha256: proof.manifestSha256, mode: 'standalone' });
        if (verifiedArchive.verified !== true || verifiedArchive.standalone !== true) fail('preservation-proof-unverified');
        const final = await native({ command: 'inspect', repoPath: ctx.repoPath, release: input.release,
          requireOwnership: true, retirementOnly: true, lockTransition: true, expectUnlocked: true,
          ...(input.wholeCheckout && { wholeCheckout: true }) });
        if (final.lockTransitionFingerprint !== fresh.review.snapshot.lockTransitionFingerprint
          || await readRetirementCheckoutIdentity(input.release.path) !== checkoutIdentity
          || JSON.stringify(await ensureOwner(ctx, unlocked, true, fresh.review)) !== JSON.stringify(fresh.review.policy)
          || JSON.stringify(await forge(ctx, input.release, input.review.prUrl)) !== JSON.stringify(fresh.review.forge)
          || !await validatePublisher(scoped) || !await legacyCurrent(scoped, { unlocked: true, archiveProofs })) fail('retirement-evidence-changed');
        state = await appendStep(directory, state, 'locked-removal-intent');
        executor.assertHeld();
        const removed = await runGit(['worktree', 'remove', '--force', input.release.path], ctx.repoPath, { ignoreExitCode: true });
        if (removed.exitCode !== 0) fail('checkout-removal-uncertain');
        const list = deps.listWorktrees || (await import('./worktreeManager.js')).listWorktrees;
        const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (!fresh.review.snapshot.privateGitDir || await exists(input.release.path) || await exists(fresh.review.snapshot.privateGitDir)
          || (await list(ctx.repoPath)).some(row => row.path === input.release.path)) fail('checkout-removal-unverified');
        state = await appendStep(directory, state, 'locked-removed');
        const deleteRef = deps.deleteRef || (await import('./worktreeManager.js')).deleteCompletedLocalBranch;
        state = await appendStep(directory, state, 'locked-branch-intent');
        const branchDeleted = await deleteRef(ctx.repoPath, input.release.branch, input.release.head, {}) === true;
        if (!branchDeleted) fail('retirement-branch-delete-refused-or-uncertain');
        state = await appendStep(directory, state, 'locked-branch-retired', { branchDeleted });
        const record = deps.recordRetirement || (await import('./branchReconcileOutcome.js')).recordHeldCheckoutRetirement;
        const outcome = await record(input.appId, { path: input.release.path, branch: input.release.branch, head: input.release.head,
          branchDeleted, checkoutIdentity, validationEvidence });
        if (!outcome?.retired?.some(row => row.path === input.release.path && row.branch === input.release.branch
          && row.head === input.release.head && row.branchDeleted === true && row.archiveDir == null
          && row.checkoutIdentity === checkoutIdentity && row.validationEvidence?.source === validationEvidence.source
          && row.validationEvidence?.prUrl === validationEvidence.prUrl && row.validationEvidence?.prHead === validationEvidence.prHead
          && row.validationEvidence?.mergeCommit === validationEvidence.mergeCommit)) fail('retirement-receipt-unverified');
        state = await appendStep(directory, state, 'locked-retired', { receiptRecorded: true });
        await gate.releaseCheckoutReservation(reservation);
        return { ok: true, transactionId: id, branchDeleted, validationEvidence };
      });
    } catch (error) {
      return { ok: false, reason: error.message, transactionId: id, recoveryRequired: true };
    } finally { if (executor) await executor.release(); }
  };

  const loadBoundTransaction = async input => {
    const directory = location(input.transactionId);
    const state = await readJournal(directory);
    if (hash(state) !== input.journalDigest) fail('retirement-journal-changed');
    const ctx = await context(input.appId);
    if (state.appId !== input.appId || state.repoPath !== ctx.repoPath) fail('retirement-transaction-app-mismatch');
    return { directory, state, ctx };
  };
  const quarantineProofInput = ({ directory, state, ctx }) => {
    const accepted = state.quarantineResumptionReview;
    const unsigned = { ...accepted };
    delete unsigned.digest;
    if (!accepted || accepted.digest !== hash(unsigned) || accepted.mode !== 'resume-initialized-quarantine'
      || accepted.transactionId !== state.id || accepted.repoPath !== ctx.repoPath
      || !sameRelease(accepted.release, state.release) || !state.proof?.manifestSha256
      || !accepted.quarantineResumption) fail('quarantine-resumption-evidence-missing');
    return { transactionDir: directory, manifestSha256: state.proof.manifestSha256,
      quarantineResumption: accepted.quarantineResumption };
  };
  const branchReview = async ({ directory, state, ctx }) => {
    const transitioned = Boolean(state.quarantineResumptionReview);
    if (!['quarantined', 'quarantined-with-metadata-transitions', 'branch-retirement-prepared'].includes(state.phase) || state.branchDeleted) fail('retirement-branch-phase-not-ready');
    const policy = await ensureOwner(ctx, state.release, false, state.review);
    const proof = await native(transitioned
      ? { command: 'verify-completed-quarantine', ...quarantineProofInput({ directory, state, ctx }) }
      : { command: 'verify', manifestSha256: state.proof?.manifestSha256, transactionDir: directory, mode: 'restore' });
    if ((transitioned && (proof.verified !== true || proof.quarantineResumptionAccepted !== true))
      || ['working', 'administration'].some(part => proof.placements?.[part]?.state !== 'quarantine')) fail('retirement-originals-not-quarantined');
    const list = deps.listWorktrees || (await import('./worktreeManager.js')).listWorktrees;
    if ((await list(ctx.repoPath)).some(tree => String(tree.branch || '').replace(/^refs\/heads\//, '') === state.release.branch)) fail('branch-has-new-holder');
    const runGit = deps.execGit || execGit;
    const head = await runGit(['rev-parse', '--verify', `refs/heads/${state.release.branch}`], ctx.repoPath, { ignoreExitCode: true });
    if (head.exitCode !== 0 || head.stdout.trim() !== state.release.head) fail('branch-ref-changed');
    const facts = await forge(ctx, state.release, state.review.forge.prUrl);
    const base = await comparison(ctx, state.release, facts.prUrl, state.review.snapshot, policy, facts);
    if (JSON.stringify(await ensureOwner(ctx, state.release, false, state.review)) !== JSON.stringify(policy)) fail('retirement-evidence-changed');
    const evidence = { ...base, mode: 'quarantined-branch', transactionId: state.id,
      journalDigest: hash(state), archiveFingerprint: proof.fingerprint,
      ...(transitioned ? { quarantineResumptionReview: state.quarantineResumptionReview,
        quarantineResumptionObservation: state.quarantineResumptionObservation ?? null } : {}) };
    delete evidence.digest;
    return { digest: hash(evidence), ...evidence };
  };
  const reviewBranch = input => fenced(async () => {
    const executor = await native({ command: 'lock', transactionDir: location(input.transactionId) }, { keepOpen: true });
    try {
      const bound = await loadBoundTransaction(input);
      const gate = await admission();
      const work = async () => {
        executor.assertHeld();
        if (hash(await readJournal(bound.directory)) !== hash(bound.state)) fail('retirement-journal-changed');
        return { ok: true, review: await branchReview(bound) };
      };
      if (bound.state.phase === 'branch-retirement-prepared') {
        const reservation = await gate.readCheckoutReservation(bound.ctx.repoPath, bound.state.id);
        if (JSON.stringify(reservation) !== JSON.stringify(bound.state.reservation)) fail('retirement-reservation-changed');
        return await gate.withCheckoutReservation(reservation, work);
      }
      return await gate.withCheckoutPublication(bound.ctx.repoPath, work);
    } finally { await executor.release(); }
  }).catch(error => ({ ok: false, reason: error.message }));
  // A receiver success was fsynced before recording the schedule receipt. Replay
  // only those completed phases: this never issues a Git mutation or recreates
  // a ref, and still refuses a new branch/holder or changed archive.
  const finishBranchReceipt = async ({ directory, ctx, state }, beforeMutation) => {
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    const gate = await admission();
    try {
      if (hash(await readJournal(directory)) !== hash(state)) fail('retirement-journal-changed');
      const verify = async () => {
        executor.assertHeld();
        await ensureOwner(ctx, state.release, false, state.review);
        let placement;
        if (state.quarantineResumptionReview) {
          placement = await native({ command: 'verify-retired-quarantine', ...quarantineProofInput({ directory, state, ctx }),
            confirmedDeletion: { journalDigest: hash(state), branch: state.release.branch, head: state.release.head, phase: state.phase } });
        } else {
          await native({ command: 'verify', manifestSha256: state.proof?.manifestSha256, transactionDir: directory, mode: 'standalone' });
          placement = await native({ command: 'status', manifestSha256: state.proof?.manifestSha256, transactionDir: directory });
        }
        if ((state.quarantineResumptionReview && (placement.verified !== true || placement.quarantineResumptionAccepted !== true))
          || ['working', 'administration'].some(part => placement.placements?.[part]?.state !== 'quarantine')) fail('retirement-originals-not-quarantined');
        const list = deps.listWorktrees || (await import('./worktreeManager.js')).listWorktrees;
        if ((await list(ctx.repoPath)).some(tree => String(tree.branch || '').replace(/^refs\/heads\//, '') === state.release.branch)) fail('branch-has-new-holder');
        const absence = await native({ command: 'verify-deleted-branch', transactionDir: directory,
          manifestSha256: state.proof?.manifestSha256, confirmedDeletion: { journalDigest: hash(state),
            branch: state.release.branch, head: state.release.head, phase: state.phase } });
        if (absence.verified !== true || absence.branchAbsent !== true) fail('retirement-deleted-branch-not-absent');
        await ensureOwner(ctx, state.release, false, state.review);
        executor.assertHeld();
      };
      const reservation = await gate.readCheckoutReservation(ctx.repoPath, state.id).catch(error => {
        if (error.code === 'ENOENT' && state.phase === 'retired' && state.receiptRecorded === true) return null;
        throw error;
      });
      if (reservation && JSON.stringify(reservation) !== JSON.stringify(state.reservation)) fail('retirement-reservation-changed');
      const finish = async () => {
        await verify();
        await beforeMutation();
        if (state.phase === 'branch-retired') {
          const record = deps.recordRetirement || (await import('./branchReconcileOutcome.js')).recordHeldCheckoutRetirement;
          await record(state.appId, { path: state.release.path, branch: state.release.branch,
            head: state.release.head, branchDeleted: true, archiveDir: directory,
            ...(state.review.checkoutIdentity && { checkoutIdentity: state.review.checkoutIdentity }) });
          state = await appendStep(directory, state, 'retired', { receiptRecorded: true });
        }
        await beforeMutation();
        if (reservation) await gate.releaseCheckoutReservation(reservation);
        return { ok: true, transactionId: state.id, branchDeleted: true, receiptRecorded: true, archiveDir: directory };
      };
      return reservation ? await gate.withCheckoutReservation(reservation, finish)
        : await gate.withCheckoutPublication(ctx.repoPath, finish);
    } finally { await executor.release(); }
  };
  const retireBranch = (input, { beforeMutation = async () => {} } = {}) => fenced(async () => {
    const bound = await loadBoundTransaction(input);
    const { directory, ctx } = bound;
    let { state } = bound;
    if (['branch-retired', 'retired'].includes(state.phase) && state.branchDeleted === true) return finishBranchReceipt(bound, beforeMutation);
    // An interrupted receiver may have completed without its journal result.
    // It is an explicit uncertainty hold, never permission to recreate a ref.
    if (state.phase === 'branch-retirement-intent') fail('retirement-branch-deletion-uncertain');
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    const gate = await admission();
    try {
      if (hash(await readJournal(directory)) !== hash(state)) fail('retirement-journal-changed');
      executor.assertHeld();
      let reservation, current;
      const prepared = state.phase === 'branch-retirement-prepared';
      if (prepared) {
        reservation = await gate.readCheckoutReservation(ctx.repoPath, state.id);
        if (JSON.stringify(reservation) !== JSON.stringify(state.reservation)) fail('retirement-reservation-changed');
      } else {
        current = await branchReview(bound);
        assertReview(current, input.review);
        await beforeMutation();
        reservation = await gate.reserveCheckoutRetirement(ctx.repoPath, state.id);
        // Durable preparation binds this new cut before lengthy verification or
        // branch archival. It grants no deletion and can be reviewed after restart.
        state = await appendStep(directory, state, 'branch-retirement-prepared', { reservation });
      }
      return await gate.withCheckoutReservation(reservation, async () => {
        const fresh = await branchReview({ ...bound, state });
        if (prepared) assertReview(fresh, input.review);
        else {
          const evidence = value => { const { digest: _digest, journalDigest: _journal, ...rest } = value; return rest; };
          // Only our just-published journal transition changed. Every substantive
          // source/archive/forge/owner field must equal the accepted review.
          if (JSON.stringify(evidence(fresh)) !== JSON.stringify(evidence(current))) fail('retirement-evidence-changed');
        }
        current = fresh;
        executor.assertHeld();
        await beforeMutation();
        const remove = deps.deleteRef || (await import('./worktreeManager.js')).deleteCompletedLocalBranch;
        let receiverAuthorized = false;
        const deleted = await remove(ctx.repoPath, state.release.branch, state.release.head, { beforeMutation: async () => {
          executor.assertHeld();
          if (JSON.stringify(await ensureOwner(ctx, state.release, false, state.review)) !== JSON.stringify(current.policy)
            || JSON.stringify(await forge(ctx, state.release, state.review.forge.prUrl)) !== JSON.stringify(current.forge)) fail('retirement-evidence-changed');
          await beforeMutation();
          executor.assertHeld();
          state = await appendStep(directory, state, 'branch-retirement-intent', { reservation, branchReview: current });
          receiverAuthorized = true;
          await beforeMutation();
          executor.assertHeld();
        } });
        if (!deleted) fail('retirement-branch-delete-refused-or-uncertain');
        if (!receiverAuthorized) fail('retirement-branch-receiver-intent-missing');
        state = await appendStep(directory, state, 'branch-retired', { branchDeleted: true, branchRetainedReason: null });
        await beforeMutation();
        const record = deps.recordRetirement || (await import('./branchReconcileOutcome.js')).recordHeldCheckoutRetirement;
        await record(state.appId, { path: state.release.path, branch: state.release.branch,
          head: state.release.head, branchDeleted: true, archiveDir: directory,
          ...(state.review.checkoutIdentity && { checkoutIdentity: state.review.checkoutIdentity }) });
        state = await appendStep(directory, state, 'retired', { receiptRecorded: true });
        await beforeMutation();
        await gate.releaseCheckoutReservation(reservation);
        return { ok: true, transactionId: state.id, branchDeleted: true, receiptRecorded: true, archiveDir: directory };
      });
    } finally { await executor.release(); }
  }).catch(error => ({ ok: false, reason: error.message, transactionId: input.transactionId, recoveryRequired: true }));

  const status = async ({ appId, transactionId }) => {
    const directory = location(transactionId);
    const state = await readJournal(directory);
    const ctx = await context(appId);
    if (state.appId !== appId || state.repoPath !== ctx.repoPath) fail('retirement-transaction-app-mismatch');
    const hasManifest = await lstat(join(directory, 'manifest.json')).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    // A manifest can be durable before its proof reaches the journal. Only a
    // proven pre-move phase may expose cancellation metadata without trusting
    // that archive; restore still requires a fresh, unchanged-source inspect.
    const unboundPreservation = hasManifest && !state.proof?.manifestSha256
      && ['intent', 'reserved', 'preserved'].includes(state.phase);
    const cancelledUnboundPreservation = state.phase === 'restored' && state.cancelledUnboundPreservation === true;
    const placement = unboundPreservation || (hasManifest && cancelledUnboundPreservation) ? { preserved: false, unverifiedArchive: true }
      : hasManifest ? await native({ command: 'status', manifestSha256: state.proof?.manifestSha256, transactionDir: directory }) : { preserved: false };
    let branchRef;
    if (state.phase === 'branch-retirement-intent') {
      const result = await (deps.execGit || execGit)(['show-ref', '--verify', '--quiet', `refs/heads/${state.release.branch}`], ctx.repoPath, { ignoreExitCode: true }).catch(() => null);
      branchRef = result?.exitCode === 0 ? 'present' : result?.exitCode === 1 ? 'absent' : 'unreadable';
    }
    return { ok: true, transactionId, phase: state.phase, release: state.release, placement,
      branchDeleted: state.branchDeleted ?? null, journalDigest: hash(state),
      ...(state.phase.startsWith('locked-') && !['locked-restored', 'locked-retired'].includes(state.phase) ? { recoveryRequired: true, reason: 'locked-retirement-recovery-held' } : {}),
      ...(unboundPreservation ? { recoveryRequired: true, recoveryAction: 'restore', reason: 'preservation-proof-unbound' } : {}),
      ...(state.phase === 'branch-retirement-intent' ? { branchDeletion: 'uncertain', branchRef, recoveryRequired: true } : {}),
      ...(state.phase === 'branch-retired' ? { receiptPending: true, recoveryRequired: true } : {}),
      ...(state.phase === 'branch-retirement-prepared' ? { recoveryRequired: true, recoveryAction: 'review-branch' } : {}),
      ...(state.quarantineResumptionReview ? { quarantineResumption: state.quarantineResumptionReview.quarantineResumption,
        quarantineResumptionComplete: state.phase === 'quarantined-with-metadata-transitions' } : {}),
      ...(state.metadataRestoreReview ? { metadataRecovery: state.metadataRestoreReview.metadataRecovery,
        metadataChangeCounts: state.metadataRestoreReview.changeCounts,
        metadataRestored: state.phase === 'restored-with-metadata-transitions' } : {}),
      ...(state.restoredFinalizationReview ? {
        restoredFinalization: state.restoredFinalizationReview.restoredFinalization,
        restoredFinalizationComplete: state.phase === 'restored-with-reviewed-finalization',
      } : {}),
      ...(['branch-retired', 'retired'].includes(state.phase) ? { recoveryAction: 'retire-branch' } : {}) };
  };

  const verifyArchive = async input => {
    const directory = location(input.transactionId);
    const state = await readJournal(directory);
    if (hash(state) !== input.journalDigest) fail('retirement-journal-changed');
    const ctx = await context(input.appId);
    if (state.appId !== input.appId || state.repoPath !== ctx.repoPath) fail('retirement-transaction-app-mismatch');
    const proof = await native({ command: 'verify', manifestSha256: state.proof?.manifestSha256, transactionDir: directory, mode: 'standalone' });
    return { ok: true, transactionId: state.id, standaloneCheckoutPath: proof.restorePath,
      verified: true, branchDeleted: state.branchDeleted ?? false, proof };
  };

  const verifyMissingPreservation = async ({ appId, repoPath, release, archiveDir }) => {
    const directory = location(archiveDir.split(/[\\/]/).at(-1));
    if (directory !== archiveDir) fail('archive-location-mismatch');
    const state = await readJournal(directory, { bounded: true });
    if (state.appId !== appId || state.repoPath !== repoPath || !sameRelease(state.release, release)) fail('archive-identity-mismatch');
    if (!['branch-retired', 'retired'].includes(state.phase) || state.branchDeleted !== true) fail('archive-retirement-unconfirmed');
    const archivedAt = state.reservation?.owner?.startedAt;
    if (!(Date.parse(archivedAt) >= Date.parse(release.createdAt)) || Date.parse(archivedAt) > Date.now()) fail('archive-generation-mismatch');
    // Every archive mutation takes this execution fence. Keep it until the
    // schedule writer accepts or refuses the evidence, not just through verify.
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    try {
      if (hash(await readJournal(directory, { bounded: true })) !== hash(state)) fail('retirement-journal-changed');
      // The journal locates the manifest; the existing native verifier checks its
      // digest, every preserved source and the standalone object closure.
      const manifestPath = join(directory, 'manifest.json');
      const info = await lstat(manifestPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) fail('archive-manifest-invalid');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.facts?.repoPath !== repoPath || !sameRelease(manifest.facts?.release, release)) fail('archive-identity-mismatch');
      const result = await verifyArchive({ appId, transactionId: state.id, journalDigest: hash(state) });
      if (result.proof?.verified !== true || result.proof?.standalone !== true) fail('archive-preservation-unverified');
      if (hash(await readJournal(directory, { bounded: true })) !== hash(state)) fail('retirement-journal-changed');
      const recheck = async () => {
        executor.assertHeld();
        const unchanged = hash(await readJournal(directory, { bounded: true })) === hash(state)
          && createHash('sha256').update(await readFile(manifestPath)).digest('hex') === state.proof.manifestSha256;
        executor.assertHeld();
        return unchanged;
      };
      return { repoPath, archiveDir: directory, archivedAt, evidenceDigest: state.proof.manifestSha256, kind: 'initialized', recheck,
        releaseFence: () => executor.release() };
    } catch (error) { await executor.release(); throw error; }
  };

  // Explicit recovery restores the exact original inodes. It does not erase
  // archives or auto-finish an interrupted ref deletion on stale forge evidence.
  const restore = (input, { cancelOnly = false } = {}) => fenced(async () => {
    const directory = location(input.transactionId);
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    const gate = await admission();
    try {
      let state = await readJournal(directory);
      if (hash(state) !== input.journalDigest) fail('retirement-journal-changed');
      if (cancelOnly && (state.proof?.manifestSha256 || !(['intent', 'reserved'].includes(state.phase)
        || (state.phase === 'restored' && state.cancelledUnboundPreservation === true)))) fail('retirement-cancellation-phase-invalid');
      const ctx = await context(input.appId);
      if (state.appId !== input.appId || state.repoPath !== ctx.repoPath) fail('retirement-transaction-app-mismatch');
      await ensureOwner(ctx, state.release, false, state.review);
      // A completed quarantine released its cut. An interrupted one retains it.
      let newReservation = false;
      const reservation = await gate.readCheckoutReservation(ctx.repoPath, state.id).catch(async error => {
        if (error.code !== 'ENOENT') throw error;
        if (['intent', 'reserved', 'preserved'].includes(state.phase) && state.reservation) fail('retirement-reservation-missing');
        newReservation = true;
        return gate.reserveCheckoutRetirement(ctx.repoPath, state.id);
      });
      return await gate.withCheckoutReservation(reservation, async () => {
        // Preservation can fail before a native manifest exists. No move is
        // ever attempted before its fsynced intent; only those early phases
        // may cancel the cut. Explicit cancellation proves placement without
        // reading/hydrating working bytes; it neither restores nor certifies them.
        if (['intent', 'reserved', 'preserved'].includes(state.phase)
          || (state.phase === 'restored' && state.cancelledUnboundPreservation === true)) {
          if (state.phase !== 'restored' && !newReservation && state.reservation
            && JSON.stringify(reservation) !== JSON.stringify(state.reservation)) fail('retirement-reservation-changed');
          let cancellationProof;
          if (cancelOnly) {
            cancellationProof = await native({ command: 'verify-original-placement',
              repoPath: ctx.repoPath, release: state.release, transactionDir: directory,
              expected: state.review.snapshot });
            if (cancellationProof.verified !== true || cancellationProof.originalsUnmoved !== true
              || cancellationProof.archiveVerified !== false || cancellationProof.contentAndMetadataUnverified !== true
              || cancellationProof.partialArchivesRetained !== true) fail('retirement-cancellation-proof-invalid');
          } else {
            const snapshot = await native({ command: 'inspect', repoPath: ctx.repoPath, release: state.release,
              ...(state.review.snapshot.wholeCheckout && { wholeCheckout: true }) });
            if (JSON.stringify(snapshot) !== JSON.stringify(state.review.snapshot)) {
              // Ordinary restore retains its original unchanged-content proof.
              if (state.proof?.manifestSha256 || state.phase === 'preserved') fail('retirement-source-changed');
              cancellationProof = await native({ command: 'verify-unmoved-preservation',
                repoPath: ctx.repoPath, release: state.release, transactionDir: directory,
                expected: state.review.snapshot });
              if (cancellationProof.verified !== true || cancellationProof.originalsUnmoved !== true) fail('retirement-source-changed');
            }
          }
          await ensureOwner(ctx, state.release, true, state.review);
          executor.assertHeld();
          state = await appendStep(directory, state, 'restored', { reservation,
            cancelledUnboundPreservation: !state.proof?.manifestSha256,
            ...(cancellationProof ? { cancellationProof } : {}) });
          await gate.releaseCheckoutReservation(reservation);
          return { ok: true, transactionId: state.id, restored: true, archivesRetained: true,
            ...(cancelOnly ? { cancelled: true, archiveVerified: false, contentAndMetadataUnverified: true } : {}) };
        }
        const { listWorktrees } = await import('./worktreeManager.js');
        const trees = await (deps.listWorktrees || listWorktrees)(ctx.repoPath);
        if (trees.some(tree => String(tree.branch || '').replace(/^refs\/heads\//, '') === state.release.branch && tree.path !== state.release.path)) fail('branch-has-new-holder');
        await native({ command: 'verify', manifestSha256: state.proof?.manifestSha256, transactionDir: directory, mode: 'restore' });
        const ref = `refs/heads/${state.release.branch}`;
        const runGit = deps.execGit || execGit;
        const existing = await runGit(['rev-parse', '--verify', ref], ctx.repoPath, { ignoreExitCode: true });
        if (existing.exitCode !== 0 || existing.stdout.trim() !== state.release.head) fail('branch-ref-changed');
        for (const part of ['administration', 'working']) {
          executor.assertHeld();
          state = await appendStep(directory, state, `restore-${part}-intent`, { reservation });
          await native({ command: 'move', manifestSha256: state.proof?.manifestSha256, transactionDir: directory, part, direction: 'restore' });
          state = await appendStep(directory, state, `restored-${part}`);
        }
        await native({ command: 'verify', manifestSha256: state.proof?.manifestSha256, transactionDir: directory, mode: 'restore' });
        state = await appendStep(directory, state, 'restored');
        await gate.releaseCheckoutReservation(reservation);
        return { ok: true, transactionId: state.id, restored: true, archivesRetained: true };
      });
    } finally { await executor.release(); }
  }).catch(error => ({ ok: false, reason: error.message, transactionId: input.transactionId, recoveryRequired: true }));

  const metadataRestoreSafety = async ({ ctx, state }) => {
    const policy = await ensureOwner(ctx, state.release, false, state.review);
    const list = deps.listWorktrees || (await import('./worktreeManager.js')).listWorktrees;
    if ((await list(ctx.repoPath)).some(tree => String(tree.branch || '').replace(/^refs\/heads\//, '') === state.release.branch
      && tree.path !== state.release.path)) fail('branch-has-new-holder');
    const head = await (deps.execGit || execGit)(['rev-parse', '--verify', `refs/heads/${state.release.branch}`],
      ctx.repoPath, { ignoreExitCode: true });
    if (head.exitCode !== 0 || head.stdout.trim() !== state.release.head) fail('branch-ref-changed');
    return policy;
  };
  const metadataReview = async bound => {
    const { directory, state, ctx } = bound;
    const allowed = ['quarantine-working-intent', 'quarantined-working', 'quarantine-administration-intent',
      'quarantined-administration', 'quarantined', 'restore-administration-intent', 'restored-administration',
      'restore-working-intent', 'restored-working', 'metadata-restore-approved', 'metadata-restore-administration-intent',
      'metadata-restored-administration', 'metadata-restore-working-intent', 'metadata-restored-working',
      'restored-with-metadata-transitions'];
    if (!allowed.includes(state.phase) || state.branchDeleted || !state.proof?.manifestSha256) fail('metadata-recovery-phase-not-ready');
    const policy = await metadataRestoreSafety(bound);
    const proof = await native({ command: 'review-metadata-recovery', transactionDir: directory,
      manifestSha256: state.proof.manifestSha256 });
    const evidence = { version: 1, mode: 'restore-metadata-only', transactionId: state.id,
      repoPath: ctx.repoPath, release: state.release, journalDigest: hash(state), phase: state.phase, policy,
      metadataRecovery: proof.metadataRecovery, initialPlacements: proof.initialPlacements,
      changeCounts: proof.changeCounts, changedPaths: proof.changedPaths };
    return { digest: hash(evidence), ...evidence };
  };
  // The CLI uses this same path before an update can be deployed. Its local
  // ownership tail is not a cross-process lock: native execution.lock and the
  // exact existing publication cut must both remain held for the entire action.
  const withMetadataRestore = (input, work) => fenced(async () => {
    const directory = location(input.transactionId);
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    try {
      const bound = await loadBoundTransaction(input);
      const gate = await admission();
      const reservation = await gate.readCheckoutReservation(bound.ctx.repoPath, bound.state.id);
      return await gate.withCheckoutReservation(reservation, async () => {
        executor.assertHeld();
        if (hash(await readJournal(directory)) !== hash(bound.state)) fail('retirement-journal-changed');
        return work(bound, { executor, gate, reservation });
      });
    } finally { await executor.release(); }
  }).catch(error => ({ ok: false, reason: error.message, transactionId: input.transactionId, recoveryRequired: true }));
  const reviewMetadataRestore = input => withMetadataRestore(input,
    async bound => ({ ok: true, review: await metadataReview(bound) }));
  const restoreMetadata = input => withMetadataRestore(input, async (bound, { executor, gate, reservation }) => {
    const current = await metadataReview(bound);
    if (current.digest !== input.review?.digest) fail('metadata-recovery-review-changed');
    if (current.initialPlacements.working === 'original' && current.initialPlacements.administration === 'original'
      && bound.state.metadataRestoreReview && bound.state.metadataRestoreObservations?.some(row => row.part === 'working' && row.proof)) {
      restoredFinalizationInputs(bound);
      fail('metadata-recovery-already-restored-use-finalization');
    }
    const { directory } = bound;
    let state = await appendStep(directory, bound.state, 'metadata-restore-approved',
      { metadataRestoreReview: current, metadataRestoreObservations: [], reservation });
    const proof = { transactionDir: directory, manifestSha256: state.proof.manifestSha256,
      metadataRecovery: current.metadataRecovery };
    for (const part of ['administration', 'working']) {
      executor.assertHeld();
      const policy = await metadataRestoreSafety({ ...bound, state });
      if (JSON.stringify(policy) !== JSON.stringify(current.policy)) fail('retirement-evidence-changed');
      state = await appendStep(directory, state, `metadata-restore-${part}-intent`);
      const moved = await native({ command: 'move', ...proof, part, direction: 'restore' });
      state = await appendStep(directory, state, `metadata-restored-${part}`, {
        metadataRestoreObservations: [...(state.metadataRestoreObservations || []), { part, proof: moved.postMoveObservation }],
      });
    }
    await native({ command: 'verify', ...proof, mode: 'restore' });
    const finalPolicy = await metadataRestoreSafety({ ...bound, state });
    if (JSON.stringify(finalPolicy) !== JSON.stringify(current.policy)) fail('retirement-evidence-changed');
    executor.assertHeld();
    state = await appendStep(directory, state, 'restored-with-metadata-transitions');
    await gate.releaseCheckoutReservation(reservation);
    return { ok: true, transactionId: state.id, phase: state.phase, restored: true, archivesRetained: true,
      metadataTransitionsPreserved: true, metadataRecovery: current.metadataRecovery, archiveDir: directory };
  });
  const quarantineSafety = async (bound, administrationQuarantined = false) => {
    const { ctx, state } = bound;
    const policy = await metadataRestoreSafety(bound);
    if (administrationQuarantined) {
      const list = deps.listWorktrees || (await import('./worktreeManager.js')).listWorktrees;
      if ((await list(ctx.repoPath)).some(tree => String(tree.branch || '').replace(/^refs\/heads\//, '') === state.release.branch)) fail('branch-has-new-holder');
    }
    const facts = await forge(ctx, state.release, state.review.forge.prUrl);
    const evidence = await comparison(ctx, state.release, facts.prUrl, state.review.snapshot, policy, facts);
    const result = { ...evidence, policy, forge: facts };
    delete result.digest;
    return result;
  };
  const quarantineReview = async (bound, reservation) => {
    const { state, directory, ctx } = bound;
    const allowed = ['quarantine-working-intent', 'quarantined-working', 'quarantine-administration-intent',
      'quarantined-administration', 'quarantined', 'quarantine-resumption-approved', 'quarantine-resumption-administration-intent',
      'quarantine-resumption-administration-complete', 'quarantined-with-metadata-transitions'];
    if (!allowed.includes(state.phase) || state.branchDeleted || !state.proof?.manifestSha256) fail('quarantine-resumption-phase-not-ready');
    if (JSON.stringify(reservation) !== JSON.stringify(state.reservation)) fail('quarantine-resumption-reservation-changed');
    const before = await quarantineSafety(bound);
    const proof = await native({ command: 'review-quarantine-resumption', transactionDir: directory,
      manifestSha256: state.proof.manifestSha256 });
    if (proof.initialPlacements?.working !== 'quarantine'
      || !['original', 'quarantine'].includes(proof.initialPlacements?.administration)) fail('quarantine-resumption-placement-not-ready');
    const current = await quarantineSafety(bound, proof.initialPlacements.administration === 'quarantine');
    if (JSON.stringify(current) !== JSON.stringify(before)) fail('retirement-evidence-changed');
    // Retain the complete comparison once. This separate hash also binds the
    // exact safety projection re-read between moves without duplicating patches.
    const evidence = { ...current, safetyEvidenceDigest: hash(current), version: 1, mode: 'resume-initialized-quarantine', transactionId: state.id,
      repoPath: ctx.repoPath, release: state.release, journalDigest: hash(state), phase: state.phase, reservation,
      quarantineResumption: proof.quarantineResumption, initialPlacements: proof.initialPlacements,
      changeCounts: proof.changeCounts, changedPaths: proof.changedPaths };
    return { digest: hash(evidence), ...evidence };
  };
  const reviewQuarantineResumption = input => withMetadataRestore(input,
    async (bound, { reservation }) => ({ ok: true, review: await quarantineReview(bound, reservation) }));
  const resumeQuarantine = (input, { beforeMutation: mutationGuard } = {}) => withMetadataRestore(input, async (bound, { executor, gate, reservation }) => {
    const beforeMutation = mutationGuard || (async () => {});
    const current = await quarantineReview(bound, reservation);
    assertReview(current, input.review);
    await beforeMutation();
    const { directory } = bound;
    let state = await appendStep(directory, bound.state, 'quarantine-resumption-approved',
      { quarantineResumptionReview: current, quarantineResumptionObservation: null });
    const proof = quarantineProofInput({ ...bound, state });
    const assertSafety = async administrationQuarantined => {
      const fresh = await quarantineSafety({ ...bound, state }, administrationQuarantined);
      if (hash(fresh) !== current.safetyEvidenceDigest) fail('retirement-evidence-changed');
      executor.assertHeld();
      await beforeMutation();
    };
    await assertSafety(current.initialPlacements.administration === 'quarantine');
    await native({ command: 'verify-quarantine-resumption', ...proof });
    if (current.initialPlacements.administration === 'original') {
      await assertSafety(false);
      state = await appendStep(directory, state, 'quarantine-resumption-administration-intent');
      await beforeMutation();
      const moved = await native({ command: 'resume-quarantine', ...proof }, mutationGuard ? { beforeMutation: async () => {
        executor.assertHeld();
        await assertSafety(false);
        executor.assertHeld();
      } } : undefined);
      if (moved.moved !== true || !moved.postMoveObservation?.file
        || !/^[a-f0-9]{64}$/.test(moved.postMoveObservation.sha256 || '')
        || !/^[a-f0-9]{64}$/.test(moved.postMoveObservation.digest || '')) fail('quarantine-postmove-evidence-missing');
      state = await appendStep(directory, state, 'quarantine-resumption-administration-complete',
        { quarantineResumptionObservation: moved.postMoveObservation ?? null });
    }
    const complete = await native({ command: 'verify-completed-quarantine', ...proof });
    if (complete.verified !== true || complete.quarantineResumptionAccepted !== true || ['working', 'administration'].some(part => complete.placements?.[part]?.state !== 'quarantine')) fail('retirement-originals-not-quarantined');
    await assertSafety(true);
    state = await appendStep(directory, state, 'quarantined-with-metadata-transitions',
      { branchDeleted: false, branchRetainedReason: 'quarantined-checkout-rollback-ref' });
    await beforeMutation();
    await gate.releaseCheckoutReservation(reservation);
    return { ok: true, transactionId: state.id, phase: state.phase, originalsQuarantined: true,
      branchDeleted: false, branchRetainedReason: state.branchRetainedReason, archiveDir: directory };
  });
  const restoredFinalizationInputs = ({ directory, state, ctx }) => {
    const prior = state.metadataRestoreReview;
    const observations = state.metadataRestoreObservations;
    const unsigned = { ...prior };
    delete unsigned.digest;
    if (!state.proof?.manifestSha256 || state.branchDeleted || !prior
      || prior.mode !== 'restore-metadata-only' || prior.digest !== hash(unsigned)
      || prior.transactionId !== state.id || prior.repoPath !== ctx.repoPath || !sameRelease(prior.release, state.release)
      || !Array.isArray(observations) || observations.length !== 2
      || observations.some((row, index) => row?.part !== ['administration', 'working'][index]
        || (row.proof == null ? index !== 0 || prior.initialPlacements?.administration !== 'original'
          : !/^[a-f0-9]{64}$/.test(row.proof.sha256 || '')
            || !/^[a-f0-9]{64}$/.test(row.proof.digest || '')))) fail('restored-finalization-evidence-missing');
    return { transactionDir: directory, manifestSha256: state.proof.manifestSha256,
      metadataRecovery: prior.metadataRecovery, postMoveObservations: observations.map(row => row.proof ?? null) };
  };
  // A separate endpoint can acknowledge a narrowly reviewed post-restoration
  // transition. It never passes that permission to a move or ordinary verifier.
  const finalizationReview = async (bound, reservation) => {
    const { state, ctx } = bound;
    if (!['metadata-restored-working', 'restored-finalization-approved'].includes(state.phase)) fail('restored-finalization-phase-not-ready');
    const input = restoredFinalizationInputs(bound);
    const policy = await metadataRestoreSafety(bound);
    const proof = await native({ command: 'review-restored-finalization', ...input });
    if (proof.placements?.working !== 'original' || proof.placements?.administration !== 'original') fail('restored-finalization-originals-not-restored');
    const evidence = { version: 1, mode: 'finalize-already-restored', transactionId: state.id,
      repoPath: ctx.repoPath, release: state.release, journalDigest: hash(state), phase: state.phase, policy,
      reservation, priorMetadataRestoreReview: state.metadataRestoreReview,
      postMoveObservations: state.metadataRestoreObservations, restoredFinalization: proof.restoredFinalization,
      placements: proof.placements, changeCounts: proof.changeCounts, changedPaths: proof.changedPaths };
    return { digest: hash(evidence), ...evidence };
  };
  const withRestoredFinalization = (input, work, allowReleased = false) => fenced(async () => {
    const directory = location(input.transactionId);
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    try {
      const bound = await loadBoundTransaction(input);
      const gate = await admission();
      const reservation = await gate.readCheckoutReservation(bound.ctx.repoPath, bound.state.id).catch(error => {
        if (error.code === 'ENOENT' && allowReleased && bound.state.phase === 'restored-with-reviewed-finalization') return null;
        throw error;
      });
      if (reservation && JSON.stringify(reservation) !== JSON.stringify(bound.state.reservation)) fail('restored-finalization-reservation-changed');
      const run = async () => {
        executor.assertHeld();
        if (hash(await readJournal(directory)) !== hash(bound.state)) fail('retirement-journal-changed');
        return work(bound, { executor, gate, reservation });
      };
      return reservation ? await gate.withCheckoutReservation(reservation, run)
        : await gate.withCheckoutPublication(bound.ctx.repoPath, run);
    } finally { await executor.release(); }
  }).catch(error => ({ ok: false, reason: error.message, transactionId: input.transactionId, recoveryRequired: true }));
  const reviewRestoredFinalization = input => withRestoredFinalization(input,
    async (bound, { reservation }) => ({ ok: true, review: await finalizationReview(bound, reservation) }));
  const finalizeRestored = input => withRestoredFinalization(input, async (bound, { executor, gate, reservation }) => {
    const { directory } = bound;
    let state = bound.state;
    const replay = state.phase === 'restored-with-reviewed-finalization';
    const current = replay ? state.restoredFinalizationReview : await finalizationReview(bound, reservation);
    const unsigned = { ...current };
    delete unsigned.digest;
    if (!current || current.mode !== 'finalize-already-restored' || current.digest !== hash(unsigned)
      || current.digest !== input.review?.digest) fail('restored-finalization-review-changed');
    if (!replay) state = await appendStep(directory, state, 'restored-finalization-approved', { restoredFinalizationReview: current });
    const policy = await metadataRestoreSafety({ ...bound, state });
    if (JSON.stringify(policy) !== JSON.stringify(current.policy)) fail('retirement-evidence-changed');
    executor.assertHeld();
    const proof = await native({ command: 'verify-restored-finalization', ...restoredFinalizationInputs({ ...bound, state }),
      restoredFinalization: current.restoredFinalization });
    if (proof.verified !== true || proof.alreadyRestored !== true || proof.restoredFinalizationAccepted !== true
      || ['working', 'administration'].some(part => proof.placements?.[part]?.state !== 'original')) fail('restored-finalization-proof-refused');
    const finalPolicy = await metadataRestoreSafety({ ...bound, state });
    if (JSON.stringify(finalPolicy) !== JSON.stringify(current.policy)) fail('retirement-evidence-changed');
    executor.assertHeld();
    if (!replay) state = await appendStep(directory, state, 'restored-with-reviewed-finalization');
    if (reservation) await gate.releaseCheckoutReservation(reservation);
    return { ok: true, transactionId: state.id, phase: state.phase, restored: true, alreadyRestored: true,
      archivesRetained: true, metadataTransitionsPreserved: true, restoredFinalization: current.restoredFinalization,
      archiveDir: directory };
  }, true);
  const recoveryBinding = async (id, expectedDigest, budget) => {
    const directory = location(id);
    const state = await readJournal(directory, { bounded: true, budget });
    const original = state.review;
    const unsigned = { ...original }; delete unsigned.digest;
    if (state.id !== id || typeof state.appId !== 'string' || !state.appId
      || !isAbsolute(state.repoPath || '') || !isAbsolute(state.release?.path || '')
      || typeof state.release?.branch !== 'string' || !state.release.branch
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(state.release?.head || '')
      || !['initialized-private-modules', 'whole-checkout'].includes(original?.mode) || original.digest !== hash(unsigned)
      || !sameRelease(original.release, state.release)) fail('retirement-journal-binding-invalid');
    const ctx = await context(state.appId);
    if (ctx.repoPath !== state.repoPath) fail('retirement-transaction-app-mismatch');
    if (expectedDigest && hash(state) !== expectedDigest) fail('retirement-journal-changed');
    return { directory, state, ctx };
  };
  const completedWithoutCut = async ({ state, ctx }) => {
    const complete = (['retired', 'locked-retired'].includes(state.phase) && state.branchDeleted === true && state.receiptRecorded === true)
      || ['restored', 'restored-with-metadata-transitions', 'restored-with-reviewed-finalization', 'locked-restored'].includes(state.phase);
    if (!complete) return false;
    const gate = await admission();
    const cut = await gate.readCheckoutReservation(ctx.repoPath, state.id).catch(async error => {
      if (error.code === 'CHECKOUT_RETIREMENT_RESERVED') {
        // A durably completed historical transaction must not consume replay
        // slots merely because a different transaction now owns this repo.
        // Validate and re-read that owner; never enter or release its cut.
        const { directory } = await gate._checkoutAdmission(ctx.repoPath);
        const ownerPath = join(directory, 'cut', 'owner.json');
        const info = await lstat(ownerPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096
          || (hostOsType() !== 'Windows_NT' && (info.mode & 0o777) !== 0o600)) fail('retirement-reservation-owner-invalid');
        const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
        if (owner.version !== 1 || !/^[a-f0-9-]{36}$/.test(owner.id || '') || owner.id === state.id
          || owner.generation !== owner.id || owner.kind !== 'snapshot' || !Number.isInteger(owner.pid)
          || typeof owner.startedAt !== 'string' || !Number.isFinite(Date.parse(owner.startedAt))) fail('retirement-reservation-owner-invalid');
        const fresh = await gate.readCheckoutReservation(ctx.repoPath, owner.id);
        if (JSON.stringify(fresh.owner) !== JSON.stringify(owner)) fail('retirement-reservation-changed');
        return null;
      }
      if (error.code !== 'ENOENT') throw error;
      // Missing owner.json inside an extant cut is uncertainty, not release.
      const { directory } = await gate._checkoutAdmission(ctx.repoPath);
      const exists = await lstat(join(directory, 'cut')).catch(readError => {
        if (readError.code === 'ENOENT') return null;
        throw readError;
      });
      if (exists) fail('retirement-reservation-owner-missing');
      return null;
    });
    return cut === null;
  };
  // Discovery reads only journals; expensive native/forge checks happen on a
  // bounded cadence in the daemon drain. A journal is a locator, never a grant.
  const discover = async () => {
    const rows = [];
    const exists = await lstat(root()).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!exists) return { ok: true, transactions: [] };
    await privateDirectory(root());
    const entries = await opendir(root());
    const budget = { remaining: 256 * 1024 * 1024 };
    let count = 0;
    for await (const entry of entries) {
      if (++count > 1000) return { ok: false, reason: 'retirement-discovery-budget-exceeded', transactions: [] };
      if (entry.name === SPOTLIGHT_MARKER && entry.isFile()) continue;
      if (!/^[a-f0-9-]{36}$/.test(entry.name)) {
        rows.push({ transactionId: null, reason: 'retirement-journal-name-invalid' });
        continue;
      }
      const row = await recoveryBinding(entry.name, undefined, budget).then(async bound => {
        const { state } = bound;
        const settled = await completedWithoutCut(bound).catch(() => false);
        return { transactionId: state.id, appId: state.appId, repoPath: state.repoPath,
          phase: state.phase, journalDigest: hash(state), release: state.release, settled };
      }).catch(error => ({ transactionId: entry.name, reason: error.message }));
      if (row.reason === 'retirement-discovery-budget-exceeded') return { ok: false, reason: row.reason, transactions: [] };
      rows.push(row);
    }
    return { ok: true, transactions: rows.sort((a, b) => String(a.transactionId).localeCompare(String(b.transactionId))) };
  };
  // Restore an unchanged checkout's lock after interruption. Never overwrite a
  // different generation or modify a partially removed tree; those stay held.
  const restoreLockedCheckout = (input, beforeMutation) => fenced(async () => {
    const bound = await recoveryBinding(input.transactionId, input.journalDigest);
    const { ctx, directory } = bound;
    let { state } = bound;
    if (state.appId !== input.appId || !['locked-intent', 'locked-reserved', 'locked-preserved',
      'locked-unlock-intent', 'locked-unlocked', 'locked-removal-intent', 'locked-restored'].includes(state.phase)) fail('locked-retirement-recovery-held');
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    try {
      if (hash(await readJournal(directory)) !== hash(state)) fail('retirement-journal-changed');
      const gate = await admission();
      const reservation = await gate.readCheckoutReservation(ctx.repoPath, state.id).catch(error => {
        if (error.code === 'ENOENT' && state.phase === 'locked-intent') return null;
        throw error;
      });
      if (state.reservation && JSON.stringify(reservation) !== JSON.stringify(state.reservation)) fail('retirement-reservation-changed');
      const restore = async () => {
        executor.assertHeld();
        const request = { command: 'inspect', repoPath: ctx.repoPath, release: state.release, requireOwnership: true,
          retirementOnly: true, lockTransition: true, ...(state.review.mode === 'whole-checkout' && { wholeCheckout: true }) };
        let unlocked = false;
        const current = await native(request).catch(async error => {
          if (error.message !== 'release-lock-changed' || !['locked-unlock-intent', 'locked-unlocked', 'locked-removal-intent'].includes(state.phase)) throw error;
          unlocked = true;
          return native({ ...request, expectUnlocked: true });
        });
        if (current.lockTransitionFingerprint !== state.review.snapshot.lockTransitionFingerprint
          || await readRetirementCheckoutIdentity(state.release.path) !== state.review.checkoutIdentity) fail('retirement-review-changed');
        const release = unlocked ? { ...state.release, locked: false, lockReason: null } : state.release;
        if (JSON.stringify(await ensureOwner(ctx, release, true, state.review)) !== JSON.stringify(state.review.policy)) fail('retirement-evidence-changed');
        await beforeMutation();
        if (unlocked) {
          const args = ['worktree', 'lock', ...(state.release.lockReason != null ? ['--reason', state.release.lockReason] : []), state.release.path];
          const locked = await (deps.execGit || execGit)(args, ctx.repoPath, { ignoreExitCode: true });
          if (locked.exitCode !== 0) fail('worktree-lock-uncertain');
          const confirmed = await native(request);
          if (confirmed.lockTransitionFingerprint !== state.review.snapshot.lockTransitionFingerprint
            || await readRetirementCheckoutIdentity(state.release.path) !== state.review.checkoutIdentity) fail('retirement-review-changed');
        }
        if (state.phase !== 'locked-restored') state = await appendStep(directory, state, 'locked-restored', reservation ? { reservation } : {});
        await beforeMutation();
        executor.assertHeld();
        if (reservation) await gate.releaseCheckoutReservation(reservation);
        return { ok: true, transactionId: state.id, phase: state.phase, restored: true };
      };
      return reservation ? await gate.withCheckoutReservation(reservation, restore) : await gate.withCheckoutPublication(ctx.repoPath, restore);
    } finally { await executor.release(); }
  });

  // A confirmed absent checkout may continue through the exact-head receiver.
  // The intent remains a hold if the receiver's outcome is interrupted.
  const resumeLockedBranch = (input, beforeMutation) => fenced(async () => {
    const bound = await recoveryBinding(input.transactionId, input.journalDigest);
    const { ctx, directory } = bound;
    let { state } = bound;
    if (state.appId !== input.appId || state.phase !== 'locked-removed') fail('locked-retirement-recovery-held');
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    try {
      if (hash(await readJournal(directory)) !== hash(state)) fail('retirement-journal-changed');
      const gate = await admission();
      const reservation = await gate.readCheckoutReservation(ctx.repoPath, state.id);
      if (JSON.stringify(reservation) !== JSON.stringify(state.reservation)) fail('retirement-reservation-changed');
      return await gate.withCheckoutReservation(reservation, async () => {
        const verify = async () => {
          executor.assertHeld();
          const proof = await native({ command: 'verify', transactionDir: directory, manifestSha256: state.proof?.manifestSha256, mode: 'standalone' });
          if (proof.verified !== true || proof.standalone !== true) fail('preservation-proof-unverified');
          const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
          const list = deps.listWorktrees || (await import('./worktreeManager.js')).listWorktrees;
          if (!state.review.snapshot.privateGitDir || await exists(state.release.path) || await exists(state.review.snapshot.privateGitDir)
            || (await list(ctx.repoPath)).some(row => row.path === state.release.path
              || String(row.branch || '').replace(/^refs\/heads\//, '') === state.release.branch)) fail('checkout-removal-unverified');
          if (JSON.stringify(await ensureOwner(ctx, state.release, false, state.review)) !== JSON.stringify(state.review.policy)
            || JSON.stringify(await forge(ctx, state.release, state.review.forge.prUrl)) !== JSON.stringify(state.review.forge)) fail('retirement-evidence-changed');
          await beforeMutation();
        };
        await verify();
        const remove = deps.deleteRef || (await import('./worktreeManager.js')).deleteCompletedLocalBranch;
        let authorized = false;
        const deleted = await remove(ctx.repoPath, state.release.branch, state.release.head, { beforeMutation: async () => {
          await verify();
          state = await appendStep(directory, state, 'locked-branch-intent');
          authorized = true;
        } });
        if (!authorized || !deleted) fail('retirement-branch-delete-refused-or-uncertain');
        state = await appendStep(directory, state, 'locked-branch-retired', { branchDeleted: true });
        return { appId: state.appId, transactionId: state.id, journalDigest: hash(state) };
      });
    } finally { await executor.release(); }
  });

  // Recheck the preserved archive and exact absences before replaying a missing
  // receipt or releasing its cut. Never repeat removal or branch deletion.
  const finishLockedReceipt = (input, beforeMutation) => fenced(async () => {
    const bound = await recoveryBinding(input.transactionId, input.journalDigest);
    const { ctx, directory } = bound;
    let { state } = bound;
    if (state.appId !== input.appId || !['locked-branch-retired', 'locked-retired'].includes(state.phase)
      || (state.phase === 'locked-retired' && state.receiptRecorded !== true)) fail('locked-retirement-recovery-held');
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    try {
      if (hash(await readJournal(directory)) !== hash(state)) fail('retirement-journal-changed');
      const gate = await admission();
      const reservation = await gate.readCheckoutReservation(ctx.repoPath, state.id);
      if (JSON.stringify(reservation) !== JSON.stringify(state.reservation)) fail('retirement-reservation-changed');
      return await gate.withCheckoutReservation(reservation, async () => {
        executor.assertHeld();
        const verified = await native({ command: 'verify', transactionDir: directory, manifestSha256: state.proof?.manifestSha256, mode: 'standalone' });
        if (verified.verified !== true || verified.standalone !== true) fail('preservation-proof-unverified');
        const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        const admin = state.review.snapshot.privateGitDir;
        const list = deps.listWorktrees || (await import('./worktreeManager.js')).listWorktrees;
        if (!admin || await exists(state.release.path) || await exists(admin)
          || (await list(ctx.repoPath)).some(row => row.path === state.release.path
            || String(row.branch || '').replace(/^refs\/heads\//, '') === state.release.branch)) fail('checkout-removal-unverified');
        const ref = await (deps.execGit || execGit)(['show-ref', '--verify', '--quiet', `refs/heads/${state.release.branch}`], ctx.repoPath, { ignoreExitCode: true });
        if (ref.exitCode !== 1) fail('retirement-deleted-branch-not-absent');
        const { forgeValidationEvidence } = await import('./heldCheckoutRecovery.js');
        const evidence = forgeValidationEvidence(state.review);
        if (!evidence || !state.review.checkoutIdentity) fail('retirement-receipt-unverified');
        const matches = outcome => outcome?.retired?.some(row => row.path === state.release.path && row.branch === state.release.branch
          && row.head === state.release.head && row.branchDeleted === true && row.archiveDir == null
          && row.checkoutIdentity === state.review.checkoutIdentity && row.validationEvidence?.source === evidence.source
          && row.validationEvidence?.prUrl === evidence.prUrl && row.validationEvidence?.prHead === evidence.prHead
          && row.validationEvidence?.mergeCommit === evidence.mergeCommit);
        const getOutcome = deps.getOutcome || (await import('./branchReconcileOutcome.js')).getBranchReconcileOutcome;
        let outcome = await getOutcome(state.appId);
        if (state.phase === 'locked-branch-retired') {
          if (!matches(outcome)) {
            await beforeMutation();
            executor.assertHeld();
            const record = deps.recordRetirement || (await import('./branchReconcileOutcome.js')).recordHeldCheckoutRetirement;
            outcome = await record(state.appId, { path: state.release.path, branch: state.release.branch, head: state.release.head,
              branchDeleted: true, checkoutIdentity: state.review.checkoutIdentity, validationEvidence: evidence });
          }
          if (!matches(outcome)) fail('retirement-receipt-unverified');
          state = await appendStep(directory, state, 'locked-retired', { receiptRecorded: true });
        }
        if (!matches(outcome)) fail('retirement-receipt-unverified');
        await beforeMutation();
        executor.assertHeld();
        await gate.releaseCheckoutReservation(reservation);
        return { ok: true, transactionId: state.id, phase: state.phase, receiptRecorded: true, branchDeleted: true };
      });
    } finally { await executor.release(); }
  });

  const automaticReview = value => {
    if (!value || value.release?.head !== value.forge?.prHead) fail('automatic-retirement-exact-pr-head-required');
    if (value.comparison?.disposition !== 'integrated' || value.comparison.difference !== '') fail('automatic-retirement-independent-review-required');
  };
  // Only the deterministic daemon calls this continuation. It never starts a
  // transaction, restores originals, adopts another cut, or accepts supersession.
  const recoverAutomatically = async (input, { blocked = async () => 'automatic-retirement-gate-required' } = {}) => {
    const permitted = async () => { const reason = await blocked(); if (reason) fail(reason); };
    const bound = await recoveryBinding(input.transactionId, input.journalDigest);
    const { state, ctx } = bound;
    if (state.appId !== input.appId) fail('retirement-transaction-app-mismatch');
    await permitted();
    if (await completedWithoutCut(bound)) return { ok: true, alreadyComplete: true, phase: state.phase, transactionId: state.id };
    if (state.phase === 'locked-removed') return finishLockedReceipt(await resumeLockedBranch(input, permitted), permitted);
    if (['locked-branch-retired', 'locked-retired'].includes(state.phase)) return finishLockedReceipt(input, permitted);
    if (['locked-intent', 'locked-reserved', 'locked-preserved', 'locked-unlock-intent', 'locked-unlocked',
      'locked-removal-intent', 'locked-restored'].includes(state.phase)) return restoreLockedCheckout(input, permitted);
    if (state.phase.startsWith('locked-')) fail('locked-retirement-recovery-held');
    if (!/^[a-f0-9]{64}$/.test(state.proof?.manifestSha256 || '')) fail('preservation-proof-unbound');
    if (state.phase === 'branch-retirement-intent') fail('retirement-branch-deletion-uncertain');
    if (['branch-retired', 'retired'].includes(state.phase) && state.branchDeleted === true) {
      // Confirmed deletion is already authorized and durable. A changed default
      // branch cannot prevent recording its receipt; this path never deletes.
      return retireBranch(input, { beforeMutation: permitted });
    }
    const finishBranch = async current => {
      await permitted();
      const reviewed = await reviewBranch(current);
      if (!reviewed.ok) return reviewed;
      automaticReview(reviewed.review);
      await permitted();
      return retireBranch({ ...current, review: { digest: reviewed.review.digest } }, { beforeMutation: permitted });
    };
    if (state.phase === 'branch-retirement-prepared') return finishBranch(input);
    const resumable = ['quarantine-working-intent', 'quarantined-working', 'quarantine-administration-intent',
      'quarantined-administration', 'quarantined', 'quarantine-resumption-approved',
      'quarantine-resumption-administration-intent', 'quarantine-resumption-administration-complete',
      'quarantined-with-metadata-transitions'];
    if (!resumable.includes(state.phase) || state.branchDeleted) fail('automatic-retirement-phase-requires-review');
    const gate = await admission();
    const reservation = await gate.readCheckoutReservation(ctx.repoPath, state.id).catch(error => {
      if (error.code === 'ENOENT' && ['quarantined', 'quarantined-with-metadata-transitions'].includes(state.phase)) return null;
      throw error;
    });
    let current = input;
    if (reservation) {
      if (JSON.stringify(reservation) !== JSON.stringify(state.reservation)) fail('retirement-reservation-changed');
      const reviewed = await reviewQuarantineResumption(current);
      if (!reviewed.ok) return reviewed;
      automaticReview(reviewed.review);
      await permitted();
      const resumed = await resumeQuarantine({ ...current, review: { digest: reviewed.review.digest } }, { beforeMutation: permitted });
      if (!resumed.ok) return resumed;
      const fresh = await recoveryBinding(state.id);
      current = { ...current, journalDigest: hash(fresh.state) };
    }
    return finishBranch(current);
  };
  const automatic = async (input, options) => recoverAutomatically(input, options)
    .catch(error => ({ ok: false, reason: error.message, transactionId: input.transactionId, recoveryRequired: true }));
  return { discover, recoverAutomatically: automatic, review, retire, status, restore,
    cancelPreservation: input => restore(input, { cancelOnly: true }), verifyArchive, verifyMissingPreservation, reviewBranch, retireBranch, reviewMetadataRestore, restoreMetadata,
    reviewRestoredFinalization, finalizeRestored, reviewQuarantineResumption, resumeQuarantine };
}

const recovery = _createInitializedCheckoutRecovery();
export const reviewInitializedCheckout = recovery.review;
export const retireInitializedCheckout = recovery.retire;
export const initializedCheckoutStatus = recovery.status;
export const restoreInitializedCheckout = recovery.restore;

export const verifyInitializedCheckoutArchive = recovery.verifyArchive;
export const verifyMissingInitializedCheckoutPreservation = recovery.verifyMissingPreservation;

export const reviewInitializedCheckoutBranch = recovery.reviewBranch;
export const retireInitializedCheckoutBranch = recovery.retireBranch;
export const reviewInitializedCheckoutMetadataRestore = recovery.reviewMetadataRestore;
export const restoreInitializedCheckoutMetadata = recovery.restoreMetadata;
export const reviewInitializedCheckoutRestoredFinalization = recovery.reviewRestoredFinalization;
export const finalizeInitializedCheckoutRestored = recovery.finalizeRestored;

export const reviewInitializedCheckoutQuarantineResumption = recovery.reviewQuarantineResumption;
export const resumeInitializedCheckoutQuarantine = recovery.resumeQuarantine;

export const discoverInitializedCheckoutRecoveries = recovery.discover;
export const recoverInitializedCheckoutAutomatically = recovery.recoverAutomatically;
