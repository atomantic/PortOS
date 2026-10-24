#!/usr/bin/env node
import { localReviewLifecycle } from '../lib/localReviewLifecycle.js';

try {
  const [action, base, value] = process.argv.slice(2);
  const result = await localReviewLifecycle(process.cwd(), {
    action, base: base || undefined,
    ...(action === 'complete' ? { status: value } : { prUrl: value || '' }),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write('Local review lifecycle evidence is missing, invalid or belongs to another delivery; preserve it and stop.\n');
  process.exitCode = 1;
}
