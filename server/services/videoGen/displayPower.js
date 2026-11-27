/**
 * Opt-in macOS display power control for local MLX video renders (mlx #3267).
 * Sleeping the display reduces WindowServer contention for Metal command
 * buffers. An attended render only sleeps the display when explicitly enabled.
 */
import { platform } from 'os';
import { spawn } from '../../lib/childProcess.js';

export function isDisplaySleepEnabled(settings) {
  return platform() === 'darwin' && settings?.displaySleep === true;
}

function runPowerCmd(cmd, args) {
  const proc = spawn(cmd, args, { stdio: 'ignore' });
  proc.on('error', () => {});
  proc.unref?.();
}

export function sleepDisplayForVideo(settings, workload = 'Video generation') {
  if (!isDisplaySleepEnabled(settings)) return false;
  runPowerCmd('pmset', ['displaysleepnow']);
  console.log(`🌙 ${workload}: slept the display to avoid the GPU-watchdog panic (mlx #3267)`);
  return true;
}

export function wakeDisplayForVideo(settings, workload = 'Video generation') {
  if (!isDisplaySleepEnabled(settings)) return false;
  runPowerCmd('caffeinate', ['-u', '-t', '5']);
  console.log(`☀️ ${workload} finished: woke the display`);
  return true;
}
