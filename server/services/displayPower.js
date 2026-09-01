/**
 * Best-effort macOS display power controls for sustained GPU work.
 *
 * Sleeping the display stops WindowServer from competing with Metal command
 * buffers on affected Apple silicon. These helpers deliberately take a
 * settings slice so each long-running workload can expose its own opt-out.
 */
import { spawn } from '../lib/childProcess.js';
import { platform } from 'os';

export const isDisplaySleepEnabled = (settings) => (
  platform() === 'darwin' && settings?.displaySleep !== false
);

function runPowerCmd(cmd, args) {
  const proc = spawn(cmd, args, { stdio: 'ignore' });
  proc.on('error', () => {});
  proc.unref?.();
  return proc;
}

export function sleepDisplay(settings, workload) {
  if (!isDisplaySleepEnabled(settings)) return false;
  runPowerCmd('pmset', ['displaysleepnow']);
  console.log(`🌙 ${workload}: slept the display to avoid the GPU-watchdog panic (mlx #3267)`);
  return true;
}

export function wakeDisplay(settings, workload) {
  if (!isDisplaySleepEnabled(settings)) return false;
  runPowerCmd('caffeinate', ['-u', '-t', '5']);
  console.log(`☀️ ${workload} finished: woke the display`);
  return true;
}
