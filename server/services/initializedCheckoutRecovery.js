/**
 * Explicit initialized-private-module retirement. Original directories are
 * quarantined whole, never unlinked. Immutable journal steps and a durable
 * repository reservation survive an interrupted request or server restart.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
export function runInitializedCheckoutNative(input, { keepOpen = false } = {}) {
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

async function privateDirectory(path, create = false) {
  assertNotRealDataWrite(path, 'initialized checkout recovery');
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) fail('retirement-journal-directory-unsafe');
}

async function appendStep(directory, state, phase, patch = {}) {
  await privateDirectory(directory);
  const next = { ...state, ...patch, phase, sequence: (state.sequence ?? -1) + 1,
    previous: state.sequence == null ? null : hash(state) };
  const file = await open(join(directory, `${String(next.sequence).padStart(6, '0')}.json`), 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(next)}\n`); await file.sync(); }
  finally { await file.close(); }
  const folder = await open(directory, 'r');
  try { await folder.sync(); } finally { await folder.close(); }
  return next;
}

async function readJournal(directory) {
  await privateDirectory(directory);
  const files = (await readdir(directory)).filter(name => /^\d{6}\.json$/.test(name)).sort();
  let previous = null;
  for (const [sequence, name] of files.entries()) {
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) fail('retirement-journal-unsafe');
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
export function createInitializedCheckoutRecovery(deps = {}) {
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
    const parent = await open(root(), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
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
        await native({ command: 'verify', transactionDir: directory });
        for (const part of ['working', 'administration']) {
          executor.assertHeld();
          state = await appendStep(directory, state, `quarantine-${part}-intent`);
          await native({ command: 'move', transactionDir: directory, part, direction: 'quarantine' });
          state = await appendStep(directory, state, `quarantined-${part}`);
        }
        await native({ command: 'verify', transactionDir: directory });
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

  const status = async ({ appId, transactionId }) => {
    const directory = location(transactionId);
    const state = await readJournal(directory);
    const ctx = await context(appId);
    if (state.appId !== appId || state.repoPath !== ctx.repoPath) fail('retirement-transaction-app-mismatch');
    const hasManifest = await lstat(join(directory, 'manifest.json')).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    const placement = hasManifest ? await native({ command: 'status', transactionDir: directory }) : { preserved: false };
    return { ok: true, transactionId, phase: state.phase, release: state.release, placement,
      branchDeleted: state.branchDeleted ?? null, journalDigest: hash(state) };
  };

  const verifyArchive = async input => {
    const directory = location(input.transactionId);
    const state = await readJournal(directory);
    if (hash(state) !== input.journalDigest) fail('retirement-journal-changed');
    const ctx = await context(input.appId);
    if (state.appId !== input.appId || state.repoPath !== ctx.repoPath) fail('retirement-transaction-app-mismatch');
    const proof = await native({ command: 'verify', transactionDir: directory, mode: 'standalone' });
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
        if (['intent', 'reserved', 'preserved'].includes(state.phase)) {
          const snapshot = await native({ command: 'inspect', repoPath: ctx.repoPath, release: state.release });
          if (JSON.stringify(snapshot) !== JSON.stringify(state.review.snapshot)) fail('retirement-source-changed');
          state = await appendStep(directory, state, 'restored', { reservation });
          await gate.releaseCheckoutReservation(reservation);
          return { ok: true, transactionId: state.id, restored: true, archivesRetained: true };
        }
        const { listWorktrees } = await import('./worktreeManager.js');
        const trees = await (deps.listWorktrees || listWorktrees)(ctx.repoPath);
        if (trees.some(tree => String(tree.branch || '').replace(/^refs\/heads\//, '') === state.release.branch && tree.path !== state.release.path)) fail('branch-has-new-holder');
        await native({ command: 'verify', transactionDir: directory, mode: 'restore' });
        const ref = `refs/heads/${state.release.branch}`;
        const runGit = deps.execGit || execGit;
        const existing = await runGit(['rev-parse', '--verify', ref], ctx.repoPath, { ignoreExitCode: true });
        if (existing.exitCode !== 0 || existing.stdout.trim() !== state.release.head) fail('branch-ref-changed');
        for (const part of ['administration', 'working']) {
          executor.assertHeld();
          state = await appendStep(directory, state, `restore-${part}-intent`, { reservation });
          await native({ command: 'move', transactionDir: directory, part, direction: 'restore' });
          state = await appendStep(directory, state, `restored-${part}`);
        }
        await native({ command: 'verify', transactionDir: directory, mode: 'restore' });
        state = await appendStep(directory, state, 'restored');
        await gate.releaseCheckoutReservation(reservation);
        return { ok: true, transactionId: state.id, restored: true, archivesRetained: true };
      });
    } finally { await executor.release(); }
  }).catch(error => ({ ok: false, reason: error.message, transactionId: input.transactionId, recoveryRequired: true }));
  return { review, retire, status, restore, verifyArchive };
}

const recovery = createInitializedCheckoutRecovery();
export const reviewInitializedCheckout = recovery.review;
export const retireInitializedCheckout = recovery.retire;
export const initializedCheckoutStatus = recovery.status;
export const restoreInitializedCheckout = recovery.restore;

export const verifyInitializedCheckoutArchive = recovery.verifyArchive;
