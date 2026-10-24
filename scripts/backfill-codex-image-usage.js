#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishAccountingFile } from '../server/services/imageRenderUsage.js';
import { planImageRenderBackfill, applyImageRenderBackfill } from '../server/services/imageRenderBackfill.js';

export async function main(args) {
  const allowed = new Set(['--data-dir', '--report', '--apply', '--journal']);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('Usage: --data-dir <data> --report <plan.json> OR --data-dir <data> --apply <plan.json> --journal <journal.json>');
    options[args[i]] = resolve(args[i + 1]);
  }
  if (!options['--data-dir']) throw new Error('An explicit --data-dir is required');
  if (options['--apply']) {
    if (!options['--journal'] || options['--report']) throw new Error('--apply requires --journal and cannot use --report');
    const reviewedPlan = JSON.parse(await readFile(options['--apply'], 'utf8'));
    return applyImageRenderBackfill(options['--data-dir'], reviewedPlan, options['--journal']);
  }
  if (!options['--report'] || options['--journal']) throw new Error('Dry run requires --report');
  const plan = await planImageRenderBackfill(options['--data-dir']);
  if (!await publishAccountingFile(options['--report'], plan)) throw new Error('Report already exists; choose a new report path');
  return { dryRun: true, inventoryHash: plan.inventoryHash, coverage: plan.coverage, unknown: plan.unknown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(err => {
    console.error(`❌ Codex image usage backfill failed: ${err.message}`);
    process.exitCode = 1;
  });
}
