/**
 * macOS display power control for local MLX video renders (GPU-watchdog
 * mitigation, mlx #3267 — same underlying mechanism documented in
 * ../loraTraining/displayPower.js).
 *
 * Unlike LoRA training (a multi-hour unattended run, default ON), a video
 * render is a short, user-attended action — sleeping the screen without
 * being asked reads as a crash. So this gate is OPT-IN: only
 * settings.videoGen.displaySleep === true enables it, and it can also be
 * turned on/off per render (see the `displaySleep` request field on
 * POST /api/video-gen).
 */
import {
  isDisplaySleepEnabled as sharedDisplaySleepEnabled,
  sleepDisplayNow,
  wakeDisplayNow,
} from '../displayPower.js';

export function isDisplaySleepEnabled(settings) {
  return sharedDisplaySleepEnabled(settings, { defaultEnabled: false });
}

export function sleepDisplayForVideo(settings, workload = 'Video generation') {
  if (!isDisplaySleepEnabled(settings)) return false;
  return sleepDisplayNow(workload);
}

export function wakeDisplayForVideo(settings, workload = 'Video generation') {
  if (!isDisplaySleepEnabled(settings)) return false;
  return wakeDisplayNow(workload);
}
