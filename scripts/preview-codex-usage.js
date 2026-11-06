#!/usr/bin/env node
import { previewCodexUsage } from '../server/services/codexUsageSources.js';

const usage = 'Usage: node scripts/preview-codex-usage.js --from YYYY-MM-DD --to YYYY-MM-DD [--home <synthetic-home>]';
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!['--from', '--to', '--home'].includes(args[i]) || !args[i + 1] || options[key] != null) throw new Error('INVALID_ARGUMENTS');
    options[key] = args[i + 1];
  }
  const result = await previewCodexUsage({ ...options, signal: controller.signal });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.stopped === 'cancelled' ? 130 : result.coverage.complete ? 0 : 2;
} catch (error) {
  const code = ['INVALID_ARGUMENTS', 'INVALID_DATE_RANGE', 'INVALID_HOME'].includes(error.message) ? error.message : 'PREVIEW_FAILED';
  process.stdout.write(`${JSON.stringify({ error: code, usage })}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
