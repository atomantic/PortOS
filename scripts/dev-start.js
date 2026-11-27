import { execFileSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { constants } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { redactPaths } from './pm2-daemon-refresh.js';
import { listPm2Processes, startPm2Apps } from './pm2-start.js';

const require = createRequire(import.meta.url);
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDir, '..');
const options = { cwd: root, stdio: 'inherit', windowsHide: true };

export const DEV_PM2_APPS = [
  'portos-server',
  'portos-cos',
  'portos-ui',
  'portos-autofixer',
  'portos-browser'
];

async function tailLogs(pm2Path, signalTarget) {
  const child = spawn(process.execPath, [pm2Path, 'logs'], options);
  let received;
  const forward = (signal) => {
    if (received) return;
    received = signal;
    child.kill(signal);
  };
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  signalTarget.on('SIGINT', onInterrupt);
  signalTarget.on('SIGTERM', onTerminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        const interruption = received ?? signal;
        resolve(interruption ? 128 + constants.signals[interruption] : code ?? 1);
      });
    });
  } finally {
    signalTarget.off('SIGINT', onInterrupt);
    signalTarget.off('SIGTERM', onTerminate);
  }
}

export async function runDev(argv, signalTarget = process) {
  if (argv.some(flag => flag !== '--restart-cos')) {
    throw new Error('Usage: npm run dev -- [--restart-cos]');
  }

  // Keep Node invocations shell-free on Windows, and resolve PM2 only after
  // ensure-deps has made its package available on a fresh install.
  for (const script of ['ensure-deps.js', 'setup-db.js', 'setup-cert.js']) {
    execFileSync(process.execPath, [join(scriptsDir, script)], options);
  }
  const pm2Path = join(dirname(require.resolve('pm2/package.json')), 'bin', 'pm2');
  await startPm2Apps({
    expectedApps: DEV_PM2_APPS,
    root,
    list: listPm2Processes,
    pm2: (...args) => execFileSync(process.execPath, [pm2Path, ...args], options),
    development: true,
    restartCos: argv.includes('--restart-cos')
  });
  return tailLogs(pm2Path, signalTarget);
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    process.exitCode = await runDev(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ Dev startup failed: ${redactPaths(err.message)}`);
    process.exitCode = 1;
  }
}
