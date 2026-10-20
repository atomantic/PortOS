/**
 * Explicit initialized-private-module retirement. Original directories are
 * quarantined whole, never unlinked. Immutable journal steps and a durable
 * repository reservation survive an interrupted request or server restart.
 */
import { spawn } from '../lib/childProcess.js';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type as hostOsType } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../lib/paths.js';
import { execGit } from '../lib/execGit.js';
import { assertNotRealDataWrite } from '../lib/testDataIsolation.js';
import { withClaimOwnershipLock } from './cosClaimOwnershipState.js';

const helper = fileURLToPath(new URL('../../scripts/lib/initialized_checkout_archive.py', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw new Error(reason); };
const sameRelease = (a, b) => ['path', 'head', 'branch', 'locked', 'lockReason'].every(key => (a[key] ?? null) === (b[key] ?? null));
const transactionRoot = () => join(PATHS.cos, 'initialized-checkout-retirements');

/** Native helper holds its own flock until the actual child exits. */
function runInitializedCheckoutNative(input, { keepOpen = false } = {}) {
  if (process.platform !== 'darwin') return Promise.reject(new Error('retirement-platform-unsupported'));
  return new Promise((resolve, reject) => {
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
    child.stdin.write(`${JSON.stringify(input)}\n`);
    if (!keepOpen) child.stdin.end();
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

async function readJournal(directory) {
  await privateDirectory(directory);
  const files = (await readdir(directory)).filter(name => /^\d{6}\.json$/.test(name)).sort();
  let previous = null;
  for (const [sequence, name] of files.entries()) {
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || (hostOsType() !== 'Windows_NT' && (info.mode & 0o777) !== 0o600)) fail('retirement-journal-unsafe');
    const row = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (row.version !== 1 || row.sequence !== sequence || row.previous !== (previous ? hash(previous) : null)) fail('retirement-journal-invalid');
    previous = row;
  }
  if (!previous) fail('retirement-journal-missing');
  return previous;
}

async function defaultContext(appId, release) {
  const [{ getAppById }, { getBranchReconcileOutcome }] = await Promise.all([import('./apps.js'), import('./taskSchedule.js')]);
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
  const native = deps.native || runInitializedCheckoutNative;
  const root = deps.root || transactionRoot;
  const context = deps.context || defaultContext;
  const fenced = deps.fenced || withClaimOwnershipLock;
  const ownership = deps.ownership || (async input => (await import('./heldCheckoutRecovery.js')).inspectCheckoutRetirementOwnership(input));
  const admission = async () => deps.admission || await import('../lib/checkoutRetirementAdmission.js');
  const forge = deps.forge || (async (ctx, release, prUrl) => (await import('./heldCheckoutReview.js')).readRetirementForgeEvidence(
    ctx.repoPath, release.branch, prUrl, { forgeAccount: ctx.forgeAccount, exactAliasHead: release.head }));
  const comparison = deps.comparison || (async (ctx, release, prUrl, snapshot, policy, forgeFacts) => {
    const { buildCheckoutRetirementReview } = await import('./heldCheckoutReview.js');
    return buildCheckoutRetirementReview({ repoPath: ctx.repoPath, release, prUrl,
      contentFingerprint: snapshot.fingerprint, administrationFingerprint: snapshot.administrationFingerprint, policy },
    { readForge: async () => forgeFacts });
  });
  const ensureOwner = async (ctx, release, registration = true) => {
    const result = await ownership({ repoPath: ctx.repoPath, release, registration });
    if (!result.ok) fail(result.reason);
    return result.policy;
  };
  const makeReview = async ({ appId, release, prUrl }) => {
    const ctx = await context(appId, release);
    const policy = await ensureOwner(ctx, release);
    const snapshot = await native({ command: 'inspect', repoPath: ctx.repoPath, release });
    const facts = await forge(ctx, release, prUrl);
    const base = await comparison(ctx, release, prUrl, snapshot, policy, facts);
    const evidence = { ...base, mode: 'initialized-private-modules', snapshot };
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
  const verifyFacts = async (ctx, state, registration) => {
    const policy = await ensureOwner(ctx, state.release, registration);
    const facts = await forge(ctx, state.release, state.review.forge.prUrl);
    if (JSON.stringify(policy) !== JSON.stringify(state.review.policy)
      || JSON.stringify(facts) !== JSON.stringify(state.review.forge)) fail('retirement-evidence-changed');
  };
  const location = id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail('retirement-transaction-invalid');
    return join(root(), id);
  };
  const retire = input => fenced(async () => {
    const prepared = await makeReview({ ...input, prUrl: input.review.prUrl });
    assertReview(prepared.review, input.review);
    const { ctx } = prepared;
    const id = randomUUID();
    await privateDirectory(root(), true);
    const directory = location(id);
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(root());
    let state = await appendStep(directory, { version: 1, id, appId: input.appId,
      repoPath: ctx.repoPath, release: input.release, review: prepared.review }, 'intent');
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    const gate = await admission();
    try {
      const reservation = await gate.reserveCheckoutRetirement(ctx.repoPath, id);
      state = await appendStep(directory, state, 'reserved', { reservation });
      return await gate.withCheckoutReservation(reservation, async () => {
        // Draining may have admitted earlier work. The exact review must still match.
        assertReview((await makeReview({ ...input, prUrl: input.review.prUrl })).review, input.review);
        executor.assertHeld();
        const preserved = await native({ command: 'preserve', repoPath: ctx.repoPath, release: input.release,
          expected: prepared.review.snapshot, transactionDir: directory });
        state = await appendStep(directory, state, 'preserved', { proof: preserved });
        await verifyFacts(ctx, state, true);
        await native({ command: 'verify', manifestSha256: state.proof?.manifestSha256, transactionDir: directory });
        for (const part of ['working', 'administration']) {
          executor.assertHeld();
          state = await appendStep(directory, state, `quarantine-${part}-intent`);
          await native({ command: 'move', manifestSha256: state.proof?.manifestSha256, transactionDir: directory, part, direction: 'quarantine' });
          state = await appendStep(directory, state, `quarantined-${part}`);
        }
        await native({ command: 'verify', manifestSha256: state.proof?.manifestSha256, transactionDir: directory });
        await verifyFacts(ctx, state, false);
        executor.assertHeld();
        // Keep the original ref available for exact in-place rollback. A later
        // branch-only retirement uses its own fresh proof and recovery archive.
        const branchDeleted = false;
        state = await appendStep(directory, state, 'quarantined', { branchDeleted,
          branchRetainedReason: 'quarantined-checkout-rollback-ref' });
        await gate.releaseCheckoutReservation(reservation);
        return { ok: true, transactionId: id, archiveDir: directory, branchDeleted,
          branchRetainedReason: state.branchRetainedReason, originalsQuarantined: true };
      });
    } catch (error) {
      // No automatic rollback after uncertainty: status/restore compare both
      // placements under a new native executor lock before touching either.
      return { ok: false, reason: error.message, transactionId: id, archiveDir: directory, recoveryRequired: true };
    } finally { await executor.release(); }
  }).catch(error => ({ ok: false, reason: error.message }));

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
    const transitioned = state.phase === 'quarantined-with-metadata-transitions';
    if ((!transitioned && state.phase !== 'quarantined') || state.branchDeleted) fail('retirement-branch-phase-not-ready');
    const policy = await ensureOwner(ctx, state.release, false);
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
    if (JSON.stringify(await ensureOwner(ctx, state.release, false)) !== JSON.stringify(policy)) fail('retirement-evidence-changed');
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
      return await (await admission()).withCheckoutPublication(bound.ctx.repoPath, async () => {
        executor.assertHeld();
        if (hash(await readJournal(bound.directory)) !== hash(bound.state)) fail('retirement-journal-changed');
        return { ok: true, review: await branchReview(bound) };
      });
    } finally { await executor.release(); }
  }).catch(error => ({ ok: false, reason: error.message }));
  // A receiver success was fsynced before recording the schedule receipt. Replay
  // only those completed phases: this never issues a Git mutation or recreates
  // a ref, and still refuses a new branch/holder or changed archive.
  const finishBranchReceipt = async ({ directory, ctx, state }) => {
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    const gate = await admission();
    try {
      if (hash(await readJournal(directory)) !== hash(state)) fail('retirement-journal-changed');
      const verify = async () => {
        executor.assertHeld();
        await ensureOwner(ctx, state.release, false);
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
        await ensureOwner(ctx, state.release, false);
        executor.assertHeld();
      };
      const reservation = await gate.readCheckoutReservation(ctx.repoPath, state.id).catch(error => {
        if (error.code === 'ENOENT' && state.phase === 'retired' && state.receiptRecorded === true) return null;
        throw error;
      });
      if (reservation && JSON.stringify(reservation) !== JSON.stringify(state.reservation)) fail('retirement-reservation-changed');
      const finish = async () => {
        await verify();
        if (state.phase === 'branch-retired') {
          const record = deps.recordRetirement || (await import('./taskSchedule.js')).recordHeldCheckoutRetirement;
          await record(state.appId, { path: state.release.path, branch: state.release.branch,
            head: state.release.head, branchDeleted: true, archiveDir: directory });
          state = await appendStep(directory, state, 'retired', { receiptRecorded: true });
        }
        if (reservation) await gate.releaseCheckoutReservation(reservation);
        return { ok: true, transactionId: state.id, branchDeleted: true, receiptRecorded: true, archiveDir: directory };
      };
      return reservation ? await gate.withCheckoutReservation(reservation, finish)
        : await gate.withCheckoutPublication(ctx.repoPath, finish);
    } finally { await executor.release(); }
  };
  const retireBranch = input => fenced(async () => {
    const bound = await loadBoundTransaction(input);
    const { directory, ctx } = bound;
    let { state } = bound;
    if (['branch-retired', 'retired'].includes(state.phase) && state.branchDeleted === true) return finishBranchReceipt(bound);
    // An interrupted receiver may have completed without its journal result.
    // It is an explicit uncertainty hold, never permission to recreate a ref.
    if (state.phase === 'branch-retirement-intent') fail('retirement-branch-deletion-uncertain');
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    const gate = await admission();
    try {
      if (hash(await readJournal(directory)) !== hash(state)) fail('retirement-journal-changed');
      executor.assertHeld();
      const current = await branchReview(bound);
      assertReview(current, input.review);
      const reservation = await gate.reserveCheckoutRetirement(ctx.repoPath, state.id);
      return await gate.withCheckoutReservation(reservation, async () => {
        assertReview(await branchReview(bound), input.review);
        executor.assertHeld();
        state = await appendStep(directory, state, 'branch-retirement-intent', { reservation, branchReview: current });
        const remove = deps.deleteRef || (await import('./worktreeManager.js')).deleteCompletedLocalBranch;
        const deleted = await remove(ctx.repoPath, state.release.branch, state.release.head);
        if (!deleted) fail('retirement-branch-delete-refused-or-uncertain');
        state = await appendStep(directory, state, 'branch-retired', { branchDeleted: true, branchRetainedReason: null });
        const record = deps.recordRetirement || (await import('./taskSchedule.js')).recordHeldCheckoutRetirement;
        await record(state.appId, { path: state.release.path, branch: state.release.branch,
          head: state.release.head, branchDeleted: true, archiveDir: directory });
        state = await appendStep(directory, state, 'retired', { receiptRecorded: true });
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
      ...(unboundPreservation ? { recoveryRequired: true, recoveryAction: 'restore', reason: 'preservation-proof-unbound' } : {}),
      ...(state.phase === 'branch-retirement-intent' ? { branchDeletion: 'uncertain', branchRef, recoveryRequired: true } : {}),
      ...(state.phase === 'branch-retired' ? { receiptPending: true, recoveryRequired: true } : {}),
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

  // Explicit recovery restores the exact original inodes. It does not erase
  // archives or auto-finish an interrupted ref deletion on stale forge evidence.
  const restore = input => fenced(async () => {
    const directory = location(input.transactionId);
    const executor = await native({ command: 'lock', transactionDir: directory }, { keepOpen: true });
    const gate = await admission();
    try {
      let state = await readJournal(directory);
      if (hash(state) !== input.journalDigest) fail('retirement-journal-changed');
      const ctx = await context(input.appId);
      if (state.appId !== input.appId || state.repoPath !== ctx.repoPath) fail('retirement-transaction-app-mismatch');
      await ensureOwner(ctx, state.release, false);
      // A completed quarantine released its cut. An interrupted one retains it.
      const reservation = await gate.readCheckoutReservation(ctx.repoPath, state.id).catch(async error => {
        if (error.code !== 'ENOENT') throw error;
        return gate.reserveCheckoutRetirement(ctx.repoPath, state.id);
      });
      return await gate.withCheckoutReservation(reservation, async () => {
        // Preservation can fail before a native manifest exists. No move is
        // ever attempted before its fsynced intent; only those early phases
        // may cancel the cut after a fresh unchanged-source inspection.
        if (['intent', 'reserved', 'preserved'].includes(state.phase)
          || (state.phase === 'restored' && state.cancelledUnboundPreservation === true)) {
          const snapshot = await native({ command: 'inspect', repoPath: ctx.repoPath, release: state.release });
          if (JSON.stringify(snapshot) !== JSON.stringify(state.review.snapshot)) fail('retirement-source-changed');
          state = await appendStep(directory, state, 'restored', { reservation,
            cancelledUnboundPreservation: !state.proof?.manifestSha256 });
          await gate.releaseCheckoutReservation(reservation);
          return { ok: true, transactionId: state.id, restored: true, archivesRetained: true };
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
    const policy = await ensureOwner(ctx, state.release, false);
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
      'quarantined-administration', 'quarantine-resumption-approved', 'quarantine-resumption-administration-intent',
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
  const resumeQuarantine = input => withMetadataRestore(input, async (bound, { executor, gate, reservation }) => {
    const current = await quarantineReview(bound, reservation);
    assertReview(current, input.review);
    const { directory } = bound;
    let state = await appendStep(directory, bound.state, 'quarantine-resumption-approved',
      { quarantineResumptionReview: current, quarantineResumptionObservation: null });
    const proof = quarantineProofInput({ ...bound, state });
    const assertSafety = async administrationQuarantined => {
      const fresh = await quarantineSafety({ ...bound, state }, administrationQuarantined);
      if (hash(fresh) !== current.safetyEvidenceDigest) fail('retirement-evidence-changed');
      executor.assertHeld();
    };
    await assertSafety(current.initialPlacements.administration === 'quarantine');
    await native({ command: 'verify-quarantine-resumption', ...proof });
    if (current.initialPlacements.administration === 'original') {
      await assertSafety(false);
      state = await appendStep(directory, state, 'quarantine-resumption-administration-intent');
      const moved = await native({ command: 'resume-quarantine', ...proof });
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
  return { review, retire, status, restore, verifyArchive, reviewBranch, retireBranch, reviewMetadataRestore, restoreMetadata,
    reviewRestoredFinalization, finalizeRestored, reviewQuarantineResumption, resumeQuarantine };
}

const recovery = _createInitializedCheckoutRecovery();
export const reviewInitializedCheckout = recovery.review;
export const retireInitializedCheckout = recovery.retire;
export const initializedCheckoutStatus = recovery.status;
export const restoreInitializedCheckout = recovery.restore;

export const verifyInitializedCheckoutArchive = recovery.verifyArchive;

export const reviewInitializedCheckoutBranch = recovery.reviewBranch;
export const retireInitializedCheckoutBranch = recovery.retireBranch;
export const reviewInitializedCheckoutMetadataRestore = recovery.reviewMetadataRestore;
export const restoreInitializedCheckoutMetadata = recovery.restoreMetadata;
export const reviewInitializedCheckoutRestoredFinalization = recovery.reviewRestoredFinalization;
export const finalizeInitializedCheckoutRestored = recovery.finalizeRestored;

export const reviewInitializedCheckoutQuarantineResumption = recovery.reviewQuarantineResumption;
export const resumeInitializedCheckoutQuarantine = recovery.resumeQuarantine;
