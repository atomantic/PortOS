/**
 * macOS display power control for LoRA training (GPU-watchdog mitigation).
 *
 * The validated root cause of the macOS GPU-watchdog kernel panic during heavy
 * sustained mflux LoRA training is an *active display*: WindowServer compositing
 * contends with the training command buffers for the GPU, and on M5-class
 * silicon that escalates to a `watchdogd` timeout that hard-reboots the box
 * (upstream mlx #3267; see docs/research/2026-06-13-mflux-training-watchdog-panic.md).
 * The clean A/B on the M5 Max: display ON → reboot at step 0; display asleep →
 * cleared the panic window (step 302).
 *
 * So PortOS sleeps the Mac's display when a run starts and wakes it when the run
 * finishes. Both are best-effort and macOS-only — a failure (or a non-darwin
 * host) must never affect the training run, so every call swallows its errors.
 *
 * These run *outside* the Express request lifecycle (spawned from the training
 * lifecycle), so per the repo convention the spawn boundary is wrapped and never
 * throws into the event loop.
 */
import {
  isDisplaySleepEnabled as sharedDisplaySleepEnabled,
  sleepDisplay,
  wakeDisplay as sharedWakeDisplay,
} from '../displayPower.js';

// Whether auto display-sleep is enabled for this host. Apple Silicon only (the
// panic is macOS-specific) and opt-out via settings.loraTraining.displaySleep.
export function isDisplaySleepEnabled(settings) {
  return sharedDisplaySleepEnabled(settings?.loraTraining);
}

// Sleep the display now (the system stays awake — the trainer's `caffeinate -is`
// holds idle/system sleep off; only the *display* goes dark so WindowServer
// stops contending for the GPU). No-op off darwin or when disabled.
export function sleepDisplayForTraining(settings) {
  return sleepDisplay(settings?.loraTraining, 'LoRA training');
}

// Wake the display so the user sees the finished run. `caffeinate -u` asserts
// user activity for a few seconds, which lights the panel back up. Gated the
// same way as sleep so we don't wake a display we never slept.
export function wakeDisplay(settings) {
  return sharedWakeDisplay(settings?.loraTraining, 'LoRA training');
}
