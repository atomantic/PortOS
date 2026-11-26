/**
 * macOS display power control for LoRA training (GPU-watchdog mitigation).
 *
 * An active display makes WindowServer contend with training for the GPU, which
 * on M5-class silicon ends in a `watchdogd` reboot (upstream mlx #3267).
 * PortOS sleeps the display at run start and wakes it at finish. Every call is
 * best-effort because it runs outside the request lifecycle.
 */
import {
  isDisplaySleepEnabled as sharedDisplaySleepEnabled,
  sleepDisplay,
  wakeDisplay as sharedWakeDisplay,
} from '../displayPower.js';

// Apple Silicon only; opt out via settings.loraTraining.displaySleep.
export function isDisplaySleepEnabled(settings) {
  return sharedDisplaySleepEnabled(settings?.loraTraining);
}

// Sleep the display only; the trainer's `caffeinate -is` keeps the system awake.
export function sleepDisplayForTraining(settings) {
  return sleepDisplay(settings?.loraTraining, 'LoRA training');
}

// Wake the display; `caffeinate -u` asserts user activity. Gated like sleep so
// we never wake a display we did not sleep.
export function wakeDisplay(settings) {
  return sharedWakeDisplay(settings?.loraTraining, 'LoRA training');
}
