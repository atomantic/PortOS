import { readFile, writeFile, rename } from 'node:fs/promises';
import { execGit } from './execGit.js';

const FILE = 'portos-local-review-lifecycle';
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
  if (content === null) return null;
  const record = Object.create(null);
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(record, match[1])) throw new Error('Invalid local review phase evidence');
    record[match[1]] = match[2];
  }
  return record;
}

async function inspectionEvidence(ctx, status) {
  const phase = await phaseRecord(ctx, 'portos-local-review-state');
  if (phase.LOCAL_OVERALL_STATUS !== status || phase.LOCAL_REMEDIATED_HEAD_SHA !== ctx.head
      || !Object.hasOwn(phase, 'LOCAL_REVIEWED_HEAD_SHA')) throw new Error('Local review phase does not match completion');
  const count = /^(0|[1-9]\d*)$/;
  if (!SHA.test(phase.LOCAL_PHASE_START_SHA) || !count.test(phase.LOCAL_PHASE_COMMITS)
      || !['true', 'false'].includes(phase.LOCAL_STOP_TRIGGERED)
      || (phase.LOCAL_STOP_TRIGGERED === 'true'
        ? !count.test(phase.LOCAL_STOP_INDEX) || !count.test(phase.LOCAL_STOP_REVIEW_COMMITS)
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
  const review = await phaseRecord(ctx, 'portos-review-status', true);
  if (review && (!['clean', 'optional-inconclusive', 'review-blocked'].includes(review.REVIEW_STATUS)
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
