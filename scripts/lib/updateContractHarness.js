import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installUpdateTestSupervisor } from './updateTestSupervisor.js';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Use the actual POSIX launch shim with an updater that reports fixture effects. */
export function installAdmittedUpdateFixture(root, effect) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(sourceRoot, 'update.sh'), join(root, 'update.sh'));
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
  for (const path of ['update.sh', 'update.ps1', 'scripts/update.mjs', 'scripts/lib/dependencyReceipts.js', 'scripts/lib/dependencyReconcile.js',
    'scripts/lib/workspaceDependencies.js', 'server/lib/gitStaleLock.js',
    'server/lib/homePath.js', 'server/lib/aiToolkit/internal/windowsSafeSpawn.js']) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceRoot, path), target);
  }
  // This fixture stops before setup, network, or service work. No downloaded
  // dependencies or platform-specific tooling is required beyond Git + Node.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0' }));
  writeFileSync(join(root, '.gitignore'), 'data/\nnode_modules/\n');
  writeFileSync(join(root, 'scripts/trusted-rebuilds.js'), 'process.exit(19);\n');
  for (const dir of ['client', 'server']) {
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
