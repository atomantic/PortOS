/**
 * Best-effort macOS display power controls for sustained GPU work.
 *
 * Sleeping the display stops WindowServer from competing with Metal command
 * buffers on affected Apple silicon. These helpers deliberately take a
 * settings slice so each long-running workload can expose its own opt-out.
 */
import { spawn } from '../lib/childProcess.js';
import { platform } from 'os';

// `defaultEnabled` is the one thing that differs between callers (LoRA
// training defaults ON — an unattended multi-hour run — while video gen
// defaults OFF — a short, attended action, see services/videoGen/displayPower.js).
// Both share the same darwin check and the same explicit-flag semantics, so
// that's the only axis a caller with a different default needs to pass.
export const isDisplaySleepEnabled = (settings, { defaultEnabled = true } = {}) => (
  platform() === 'darwin' && (defaultEnabled ? settings?.displaySleep !== false : settings?.displaySleep === true)
);

function runPowerCmd(cmd, args) {
  const proc = spawn(cmd, args, { stdio: 'ignore' });
  proc.on('error', () => {});
  proc.unref?.();
  return proc;
}

// Unconditional actions — callers with their own enablement gate (e.g. video
// gen's opt-in default, see services/videoGen/displayPower.js) call these
// directly rather than going through the opt-out gate below.
export function sleepDisplayNow(workload) {
  runPowerCmd('pmset', ['displaysleepnow']);
  console.log(`🌙 ${workload}: slept the display to avoid the GPU-watchdog panic (mlx #3267)`);
  return true;
}

export function wakeDisplayNow(workload) {
  runPowerCmd('caffeinate', ['-u', '-t', '5']);
  console.log(`☀️ ${workload} finished: woke the display`);
  return true;
}

export function sleepDisplay(settings, workload) {
  if (!isDisplaySleepEnabled(settings)) return false;
  return sleepDisplayNow(workload);
}

export function wakeDisplay(settings, workload) {
  if (!isDisplaySleepEnabled(settings)) return false;
  return wakeDisplayNow(workload);
}
