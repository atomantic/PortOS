import { readFile, writeFile, rename } from 'node:fs/promises';
import { execGit } from './execGit.js';

const FILE = 'portos-local-review-lifecycle';
const SHA = /^[a-f0-9]{40}$/;
const STATUSES = ['clean', 'partial', 'review-blocked'];

async function context(cwd) {
  const git = async args => (await execGit(args, cwd)).stdout.trim();
  return {
    path: await git(['rev-parse', '--path-format=absolute', '--git-path', FILE]),
    branch: await git(['symbolic-ref', '--short', 'HEAD']),
    origin: await git(['remote', 'get-url', 'origin']),
    head: await git(['rev-parse', 'HEAD']),
  };
}

async function load(ctx) {
  const content = await readFile(ctx.path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (content === null) return null;
  const receipt = JSON.parse(content);
  if (receipt.version !== 1 || !STATUSES.includes(receipt.status) || !SHA.test(receipt.reviewedHead)
      || typeof receipt.base !== 'string' || !receipt.base || typeof receipt.prUrl !== 'string') {
    throw new Error('Invalid local review lifecycle receipt');
  }
  return receipt;
}

async function save(ctx, receipt) {
  await writeFile(`${ctx.path}.tmp`, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await rename(`${ctx.path}.tmp`, ctx.path);
}

/** A completed phase is durable for one delivery, never a verdict on later commits. */
export async function localReviewLifecycle(cwd, { action = 'check', base, status, prUrl = '' } = {}) {
  const ctx = await context(cwd);
  const receipt = await load(ctx);
  const matches = receipt && receipt.branch === ctx.branch && receipt.origin === ctx.origin && (!base || receipt.base === base);
  if (action === 'complete') {
    if (!base || !STATUSES.includes(status)) throw new Error('Local review phase is incomplete');
    if (matches && receipt.prUrl && receipt.status !== 'review-blocked') throw new Error('Published delivery requires explicit re-review');
    const completed = { version: 1, branch: ctx.branch, origin: ctx.origin, base, status, reviewedHead: ctx.head, prUrl: matches && receipt.status === 'review-blocked' ? receipt.prUrl : '' };
    await save(ctx, completed);
    return completed;
  }
  if (action === 'publish') {
    if (!prUrl || !matches || (receipt.prUrl ? receipt.prUrl !== prUrl : receipt.reviewedHead !== ctx.head)) {
      throw new Error('PR does not match completed local review delivery');
    }
    await save(ctx, { ...receipt, prUrl });
    return { ...receipt, prUrl };
  }
  if (action !== 'check') throw new Error('Unknown local review lifecycle action');
  const reusable = Boolean(matches && (prUrl ? receipt.prUrl === prUrl : !receipt.prUrl && receipt.reviewedHead === ctx.head));
  return { reusable, legacyPublished: Boolean(prUrl && !receipt), receipt: reusable ? receipt : null };
}
