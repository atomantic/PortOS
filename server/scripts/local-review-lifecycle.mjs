#!/usr/bin/env node
import { localReviewLifecycle, writeLocalReviewState } from '../lib/localReviewLifecycle.js';

const [action, base, value, ...args] = process.argv.slice(2);
const writesState = ['init-phase', 'write-phase', 'init-status', 'write-status', 'record-head'].includes(action);

try {
  if (writesState) {
    await writeLocalReviewState(process.cwd(), action, base, value, args);
  } else {
    const publicationHead = action === 'publication-head';
    const result = await localReviewLifecycle(process.cwd(), {
      action: publicationHead ? 'check' : action, base: base || undefined,
      ...(action === 'complete' ? { status: value } : { prUrl: publicationHead ? '' : value || '' }),
    });
    if (publicationHead && (!base || !result.reusable || result.receipt.status !== value)) throw new Error('Incomplete local review delivery');
    process.stdout.write(`${publicationHead ? result.inspection.completedHead : JSON.stringify(result)}\n`);
  }
} catch {
  process.stderr.write(writesState
    ? 'Local review state write refused. Check the target worktree, branch and saved evidence.\n'
    : 'Local review lifecycle evidence is missing, invalid or belongs to another delivery; preserve it and stop.\n');
  process.exitCode = 1;
}
