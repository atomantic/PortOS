#!/usr/bin/env node
// Opt-in investigation only. Ordinary CI keeps its capture policy unchanged.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { planTestMemo, writeSelectionFile } from './lib/testMemoRunner.js';
import { resolveTestChrome } from './lib/testChrome.js';

import { POSTER } from './posterCiMatrixConfig.js';

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const server = join(root, 'server');
  const git = () => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const revision = git();
  if (!revision || (process.env.GITHUB_SHA && revision !== process.env.GITHUB_SHA)) throw Error('Checkout does not match dispatched revision');
  const chrome = resolveTestChrome();
  if (!chrome) throw Error('Chrome unavailable: refusing to count skipped poster tests');
  const version = spawnSync(chrome, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw Error('Chrome version probe failed');
  console.log(`Revision ${revision}; ${version.stdout.trim()}; Node ${process.version}`);
  const plans = [1, 2].map(index => planTestMemo({ scope: 'server', mode: 'full', repoFiles: [], repoSources: [], memoDir: null, repoRoot: root, shard: { index, count: 2 } }));
  const index = plans.findIndex(plan => plan.run.includes(`server/${POSTER}`));
  if (index < 0 || plans.filter(plan => plan.run.includes(`server/${POSTER}`)).length !== 1) throw Error('Poster not in exactly one server shard');
  const selection = writeSelectionFile({ scope: 'server', include: plans[index].run, exclude: [] });
  const scratch = mkdtempSync(join(tmpdir(), 'portos-poster-matrix-'));
  const config = join(scratch, 'matrix.config.mjs');
  writeFileSync(config, `import config from ${JSON.stringify(pathToFileURL(join(server, 'vitest.config.js')).href)};\nimport { withPosterPlacement } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/posterCiMatrixConfig.js')).href)};\nexport default withPosterPlacement(config, process.env.POSTER_MATRIX_PLACEMENT);\n`);
  try {
    console.log(`Full server shard ${index + 1}/2: ${plans[index].run.length} files; memo disabled; four runs: parallel, capture, capture, parallel`);
    for (const [round, placement] of ['parallel', 'capture', 'capture', 'parallel'].entries()) {
      if (git() !== revision) throw Error('Revision changed during matrix');
      console.log(`Matrix run ${round + 1}: ${placement}`);
      const start = Date.now();
      const result = spawnSync(process.execPath, [join(root, 'scripts/run-vitest-ci.js'), 'run', '--silent=passed-only', '--reporter=default', '--reporter=github-actions', '--configLoader', 'runner', '--config', config], {
        cwd: server, stdio: 'inherit', env: { ...process.env, CHROME_PATH: chrome, POSTER_MATRIX_PLACEMENT: placement, PORTOS_TEST_MEMO: 'off', PORTOS_CI_TEST_SELECTION: selection.path },
      });
      console.log(`Matrix run ${round + 1}: placement=${placement} status=${result.status ?? 'unavailable'} elapsedMs=${Date.now() - start}`);
      if (result.error || result.status !== 0) { process.exitCode = 1; break; }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(selection.dir, { recursive: true, force: true });
  }
}
if (isDirectlyInvoked(import.meta.url)) main();
