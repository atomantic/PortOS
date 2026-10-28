#!/usr/bin/env node
import { localReviewLifecycle } from '../lib/localReviewLifecycle.js';

try {
  const [action, base, value] = process.argv.slice(2);
  const publicationHead = action === 'publication-head';
  const result = await localReviewLifecycle(process.cwd(), {
    action: publicationHead ? 'check' : action, base: base || undefined,
    ...(action === 'complete' ? { status: value } : { prUrl: publicationHead ? '' : value || '' }),
  });
  if (publicationHead && (!base || !result.reusable || result.receipt.status !== value)) throw new Error('Incomplete local review delivery');
  process.stdout.write(`${publicationHead ? result.inspection.completedHead : JSON.stringify(result)}\n`);
} catch {
  process.stderr.write('Local review lifecycle evidence is missing, invalid or belongs to another delivery; preserve it and stop.\n');
  process.exitCode = 1;
}
