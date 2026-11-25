/**
 * `localReviewLifecycle`, `localReviewReceiptEvidence` — durable pre-PR completion bound to the
 * branch, origin, base and exact PR delivery.
 *
 * Separates completed and actual inspected heads, with explicit legacy uncertainty.
 */

import { readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { atomicWrite } from './fileCore.js';
import { execGit } from './execGit.js';

const FILE = 'portos-local-review-lifecycle';
const PHASE_FILE = 'portos-local-review-state';
const STATUS_FILE = 'portos-review-status';
const SHA = /^[a-f0-9]{40}$/;
const STATUSES = ['clean', 'partial', 'review-blocked'];

async function context(cwd) {
  const git = async args => (await execGit(args, cwd)).stdout.trim();
  return {
    git,
    path: await git(['rev-parse', '--path-format=absolute', '--git-path', FILE]),
    branch: await git(['symbolic-ref', '--short', 'HEAD']),
    origin: await git(['remote', 'get-url', 'origin']),
    head: await git(['rev-parse', 'HEAD']),
  };
}

/** Version 1's reviewedHead recorded completion, not proven inspection. */
export function localReviewReceiptEvidence(receipt) {
  if (!receipt || ![1, 2].includes(receipt.version) || !STATUSES.includes(receipt.status)
      || typeof receipt.branch !== 'string' || !receipt.branch || typeof receipt.origin !== 'string' || !receipt.origin
      || typeof receipt.base !== 'string' || !receipt.base || typeof receipt.prUrl !== 'string') {
    throw new Error('Invalid local review lifecycle receipt');
  }
  if (receipt.version === 1 && SHA.test(receipt.reviewedHead)) {
    return { completedHead: receipt.reviewedHead, reviewedHead: null, inspectionProvenance: 'legacy-unknown' };
  }
  if (receipt.version === 2 && SHA.test(receipt.completedHead)
      && ((receipt.inspectionProvenance === 'recorded' && SHA.test(receipt.reviewedHead))
        || (receipt.inspectionProvenance === 'unavailable' && receipt.reviewedHead === null))) {
    return { completedHead: receipt.completedHead, reviewedHead: receipt.reviewedHead, inspectionProvenance: receipt.inspectionProvenance };
  }
  throw new Error('Invalid local review lifecycle receipt');
}

async function load(ctx) {
  const content = await readFile(ctx.path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (content === null) return null;
  const receipt = JSON.parse(content);
  localReviewReceiptEvidence(receipt);
  return receipt;
}

// Parse private shell-style records as data; never execute their contents.
async function phaseRecord(ctx, name, optional = false) {
  const path = await ctx.git(['rev-parse', '--path-format=absolute', '--git-path', name]);
  const content = await readFile(path, 'utf8').catch(error => {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  });
  return content === null ? null : parseRecord(content);
}

function parseRecord(content) {
  const record = Object.create(null);
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(record, match[1])) throw new Error('Invalid local review phase evidence');
    record[match[1]] = match[2];
  }
  return record;
}

const RECORD_STATUSES = ['clean', 'optional-inconclusive', 'review-blocked'];
const COUNT = /^(0|[1-9]\d*)$/;
const COUNT_OR_UNSET = /^(-1|0|[1-9]\d*)$/;
const PHASE_FIELDS = {
  LOCAL_PHASE_START_SHA: value => SHA.test(value),
  LOCAL_OVERALL_STATUS: value => value === 'incomplete' || STATUSES.includes(value),
  LOCAL_STOP_TRIGGERED: value => ['false', 'true'].includes(value),
  LOCAL_STOP_INDEX: value => COUNT_OR_UNSET.test(value),
  LOCAL_STOP_REVIEW_COMMITS: value => COUNT_OR_UNSET.test(value),
  LOCAL_PHASE_COMMITS: value => COUNT.test(value),
  LOCAL_REVIEWED_HEAD_SHA: value => value === '' || SHA.test(value),
  LOCAL_REMEDIATED_HEAD_SHA: value => value === '' || SHA.test(value),
};

const recordText = record => Object.entries(record).map(([key, value]) => `${key}=${value}\n`).join('');

async function checkedContext(cwd, worktree, branch) {
  if (!worktree || !isAbsolute(worktree) || !branch) throw new Error('Expected worktree and branch required');
  // Git's repository-selection environment must not redirect this check or its writes.
  const { stdout } = await execGit(['rev-parse', '--local-env-vars'], cwd);
  const localVars = new Set(stdout.trim().split(/\r?\n/));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !localVars.has(key)));
  const git = async args => (await execGit(args, cwd, { env })).stdout.replace(/\r?\n$/, '');
  const root = await git(['rev-parse', '--show-toplevel']);
  if (await realpath(root) !== await realpath(worktree) ||
      await git(['symbolic-ref', 'HEAD']) !== `refs/heads/${branch}`) {
    throw new Error('Local review checkout or branch mismatch');
  }
  return { git };
}

/** Write only private evidence for the explicitly selected checkout and branch. */
export async function writeLocalReviewState(cwd, action, worktree, branch, args) {
  const ctx = await checkedContext(cwd, worktree, branch);
  const phaseAction = action === 'init-phase' || action === 'write-phase';
  const name = phaseAction ? PHASE_FILE : STATUS_FILE;
  const path = await ctx.git(['rev-parse', '--path-format=absolute', '--git-path', name]);
  if (action === 'init-phase' && args.length === 0) {
    await writeFile(path, recordText({
      LOCAL_PHASE_START_SHA: await ctx.git(['rev-parse', 'HEAD']),
      LOCAL_OVERALL_STATUS: 'incomplete',
      LOCAL_STOP_TRIGGERED: 'false',
      LOCAL_STOP_INDEX: '-1',
      LOCAL_STOP_REVIEW_COMMITS: '-1',
      LOCAL_PHASE_COMMITS: '0',
      LOCAL_REVIEWED_HEAD_SHA: '',
      LOCAL_REMEDIATED_HEAD_SHA: '',
    }), { flag: 'wx', mode: 0o600 });
    return;
  }
  if (action === 'write-phase' && args.length) {
    const patch = parseRecord(args.join('\n'));
    if (Object.keys(patch).length !== args.length || args.some(arg => /[\r\n]/.test(arg)) ||
        Object.entries(patch).some(([key, value]) => !Object.hasOwn(PHASE_FIELDS, key) || !PHASE_FIELDS[key](value))) {
      throw new Error('Invalid phase update');
    }
    const prior = await phaseRecord(ctx, name);
    if (Object.hasOwn(patch, 'LOCAL_PHASE_START_SHA') && patch.LOCAL_PHASE_START_SHA !== prior.LOCAL_PHASE_START_SHA) {
      throw new Error('Cannot replace phase start');
    }
    await atomicWrite(path, recordText({ ...prior, ...patch }));
    return;
  }
  const prior = await phaseRecord(ctx, name, true);
  if (action === 'init-status' && !args.length) {
    if (!prior) await writeFile(path, 'REVIEW_STATUS=clean\n', { flag: 'wx', mode: 0o600 });
    return;
  }
  if (action === 'record-head' && args.length === 1 && SHA.test(args[0])) {
    if (prior) await atomicWrite(path, recordText({ ...prior, REVIEW_HEAD: args[0] }));
    return;
  }
  const [status, head] = args;
  if (action !== 'write-status' || args.length > 2 || !RECORD_STATUSES.includes(status) ||
      (head !== undefined && !SHA.test(head))) throw new Error('Invalid status update');
  if (status === 'optional-inconclusive' &&
      (!['clean', 'optional-inconclusive'].includes(prior?.REVIEW_STATUS) || head !== await ctx.git(['rev-parse', 'HEAD']))) {
    throw new Error('Optional review evidence does not match the current attempt');
  }
  const content = recordText({ REVIEW_STATUS: status, ...(head ? { REVIEW_HEAD: head } : {}) });
  if (prior) await atomicWrite(path, content);
  else await writeFile(path, content, { flag: 'wx', mode: 0o600 });
}

async function inspectionEvidence(ctx, status) {
  const phase = await phaseRecord(ctx, PHASE_FILE);
  if (phase.LOCAL_OVERALL_STATUS !== status || phase.LOCAL_REMEDIATED_HEAD_SHA !== ctx.head
      || !Object.hasOwn(phase, 'LOCAL_REVIEWED_HEAD_SHA')) throw new Error('Local review phase does not match completion');
  if (!SHA.test(phase.LOCAL_PHASE_START_SHA) || !COUNT.test(phase.LOCAL_PHASE_COMMITS)
      || !['true', 'false'].includes(phase.LOCAL_STOP_TRIGGERED)
      || (phase.LOCAL_STOP_TRIGGERED === 'true'
        ? !COUNT.test(phase.LOCAL_STOP_INDEX) || !COUNT.test(phase.LOCAL_STOP_REVIEW_COMMITS)
          || Number(phase.LOCAL_STOP_REVIEW_COMMITS) > Number(phase.LOCAL_PHASE_COMMITS)
        : phase.LOCAL_STOP_INDEX !== '-1' || phase.LOCAL_STOP_REVIEW_COMMITS !== '-1')
      || (status === 'partial' && phase.LOCAL_STOP_TRIGGERED !== 'true')) throw new Error('Invalid local review stop evidence');
  await ctx.git(['merge-base', '--is-ancestor', phase.LOCAL_PHASE_START_SHA, ctx.head]);
  if (await ctx.git(['rev-list', '--count', `${phase.LOCAL_PHASE_START_SHA}..${ctx.head}`]) !== phase.LOCAL_PHASE_COMMITS) {
    throw new Error('Local review phase commit count does not match completion');
  }
  const reviewedHead = phase.LOCAL_REVIEWED_HEAD_SHA || null;
  if (phase.LOCAL_STOP_TRIGGERED === 'true' && reviewedHead === null) throw new Error('Local review stop has no actual inspection');
  if (reviewedHead !== null) {
    if (!SHA.test(reviewedHead)) throw new Error('Invalid local review inspection head');
    await ctx.git(['merge-base', '--is-ancestor', reviewedHead, ctx.head]);
    await ctx.git(['merge-base', '--is-ancestor', phase.LOCAL_PHASE_START_SHA, reviewedHead]);
  }
  const review = await phaseRecord(ctx, STATUS_FILE, true);
  if (review && (!RECORD_STATUSES.includes(review.REVIEW_STATUS)
      || (Object.hasOwn(review, 'REVIEW_HEAD') && !SHA.test(review.REVIEW_HEAD)))) {
    throw new Error('Invalid local review status evidence');
  }
  if (review?.REVIEW_HEAD && review.REVIEW_STATUS === 'clean' && review.REVIEW_HEAD !== reviewedHead) {
    throw new Error('Conflicting local review inspection evidence');
  }
  return { reviewedHead, inspectionProvenance: reviewedHead ? 'recorded' : 'unavailable' };
}

async function save(ctx, receipt) {
  await writeFile(`${ctx.path}.tmp`, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await rename(`${ctx.path}.tmp`, ctx.path);
}

/** A completed phase is durable for one delivery, never a verdict on later commits. */
export async function localReviewLifecycle(cwd, { action = 'check', base, status, prUrl = '' } = {}) {
  const ctx = await context(cwd);
  const receipt = await load(ctx);
  const evidence = receipt && localReviewReceiptEvidence(receipt);
  const matches = receipt && receipt.branch === ctx.branch && receipt.origin === ctx.origin && (!base || receipt.base === base);
  if (action === 'complete') {
    if (!base || !STATUSES.includes(status)) throw new Error('Local review phase is incomplete');
    if (matches && receipt.prUrl && receipt.status !== 'review-blocked') throw new Error('Published delivery requires explicit re-review');
    const inspection = await inspectionEvidence(ctx, status);
    const completed = { version: 2, branch: ctx.branch, origin: ctx.origin, base, status, completedHead: ctx.head,
      ...inspection, prUrl: matches && receipt.status === 'review-blocked' ? receipt.prUrl : '' };
    await save(ctx, completed);
    return completed;
  }
  if (action === 'publish') {
    if (!prUrl || !matches || (receipt.prUrl ? receipt.prUrl !== prUrl : evidence.completedHead !== ctx.head)) {
      throw new Error('PR does not match completed local review delivery');
    }
    await save(ctx, { ...receipt, prUrl });
    return { ...receipt, prUrl };
  }
  if (action !== 'check') throw new Error('Unknown local review lifecycle action');
  const reusable = Boolean(matches && (prUrl ? receipt.prUrl === prUrl : !receipt.prUrl && evidence.completedHead === ctx.head));
  return { reusable, legacyPublished: Boolean(prUrl && !receipt), receipt: reusable ? receipt : null,
    inspection: reusable ? evidence : null };
}
