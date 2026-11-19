import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installUpdateTestSupervisor } from './updateTestSupervisor.js';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const shimFiles = ['update.sh', 'update.ps1'];

function copyFromSource(root, path) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(sourceRoot, path), target);
}

/** Use actual launch shims, but substitute an updater with observable fixture-only effects. */
export function installAdmittedUpdateFixture(root, effect) {
  copyFromSource(root, 'update.sh');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'update.mjs'), `
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const id = process.env.PORTOS_DEFERRED_UPDATE_ID;
const command = (...args) => execFileSync(process.execPath, ['scripts/deferred-update.mjs', ...args], { stdio: 'inherit' });
command('--enter', id, String(process.pid));
${effect}
command('--terminal', id, String(process.pid), '0');
`);
}

/** Use the actual updater and its builtin-only imports in an offline test checkout. */
export function installUpdateContract(root) {
  installUpdateTestSupervisor(root, { standalone: true });
  for (const path of [...shimFiles, 'scripts/update.mjs', 'server/lib/gitStaleLock.js',
    'server/lib/homePath.js', 'server/lib/aiToolkit/internal/windowsSafeSpawn.js']) copyFromSource(root, path);
  // This fixture stops before setup, network, or service work. No downloaded
  // dependencies or platform-specific tooling is required beyond Git + Node.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0' }));
  writeFileSync(join(root, '.gitignore'), 'data/\nnode_modules/\n');
  writeFileSync(join(root, 'scripts/trusted-rebuilds.js'), 'process.exit(19);\n');
  for (const dir of ['client', 'server', 'autofixer']) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), '{}');
  }
}

export function recordedSteps(result) {
  return result.stdout.split(/\r?\n/).filter(line => line.startsWith('STEP:')).map(line => line.split(':').slice(1, 3).join(':'));
}

export function readUpdateLog(repo) {
  try { return readFileSync(join(repo, 'data', 'update.log'), 'utf8'); }
  catch { return ''; }
}
