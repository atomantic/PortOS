// Machine-local FaceTime Audio control plane. The native helper owns all AX UI
// interaction; this boundary accepts only its strict, one-object JSON protocol.

import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { bufferedSpawn } from '../../lib/bufferedSpawn.js';
import { getVoiceConfig, voiceHome } from './config.js';
import { isInstanceFeatureEnabled } from '../instanceFeatures.js';
import { ServerError } from '../../lib/errorHandler.js';

export const FACETIME_COMMANDS = ['probe', 'call', 'answer', 'hangup'];
const HELPER_NAME = process.platform === 'win32' ? 'facetime-ax.exe' : 'facetime-ax';
const FACETIME_TIMEOUT_MS = 40_000;

export const facetimeControlResultSchema = z.object({
  ok: z.boolean(),
  command: z.enum(FACETIME_COMMANDS),
  state: z.enum(['idle', 'dialing', 'connected', 'ended', 'unknown']),
  authorized: z.boolean(),
  action: z.string().max(160),
  message: z.string().max(1000),
  errorCode: z.string().max(120).nullable(),
}).strict();

export const facetimeHelperPath = () => join(voiceHome(), HELPER_NAME);

// The call audio path needs two virtual devices at the rate FaceTime runs at.
// Anything else is a misconfiguration the user has to fix in Audio MIDI Setup,
// so the check names the specific device rather than reporting "audio broken".
export const CALL_AUDIO_DEVICE_RATE = 48_000;
const AUDIO_PROBE_TIMEOUT_MS = 10_000;

const deviceChannels = (item, direction) => {
  const raw = item?.[`coreaudio_device_${direction}`];
  const parsed = Number.parseInt(String(raw ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Read the machine's audio devices.
 *
 * Returns `null` — not `[]` — when the list could not be read at all, so a
 * failed probe is never reported as "the device is missing" and the user is
 * not sent to reinstall something that is already there.
 */
export async function listAudioDevices() {
  if (process.platform !== 'darwin') return null;
  const result = await bufferedSpawn('system_profiler', ['SPAudioDataType', '-json'], { timeoutMs: AUDIO_PROBE_TIMEOUT_MS });
  if (result.timedOut || !result.success) return null;
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const items = parsed?.SPAudioDataType?.[0]?._items;
  if (!Array.isArray(items)) return null;
  return items.map((item) => ({
    name: String(item?._name ?? ''),
    sampleRate: Number.parseInt(String(item?.coreaudio_device_srate ?? '').replace(/[^0-9]/g, ''), 10) || 0,
    inputChannels: deviceChannels(item, 'input'),
    outputChannels: deviceChannels(item, 'output'),
  }));
}

/** Grade one BlackHole device against the label, rate, and channel count. */
export function checkAudioDevice(devices, label, channels) {
  if (devices === null) return fact(false, `Could not read this Mac's audio devices to verify ${label}.`);
  const device = devices.find((entry) => entry.name.trim().toLowerCase() === label.trim().toLowerCase());
  if (!device) return fact(false, `Install ${label} with: brew install blackhole-${channels}ch`);
  if (device.sampleRate !== CALL_AUDIO_DEVICE_RATE) {
    return fact(false, `Set ${label} to ${CALL_AUDIO_DEVICE_RATE} Hz in Audio MIDI Setup (currently ${device.sampleRate || 'unknown'} Hz).`);
  }
  if (Math.max(device.inputChannels, device.outputChannels) < channels) {
    return fact(false, `${label} reports fewer than ${channels} channels — reinstall it with: brew install blackhole-${channels}ch`);
  }
  return fact(true, `${label} is present at ${CALL_AUDIO_DEVICE_RATE} Hz with ${channels} channels.`);
}

const identityReady = (config) => Boolean(config?.facetime?.targetHandle?.trim() && config?.facetime?.targetName?.trim());

const fact = (ok, message) => ({ ok: ok ? 'ok' : 'missing', message });

export async function checkSetup(config) {
  const voiceConfig = config || await getVoiceConfig();
  const facetime = voiceConfig.facetime || {};
  const helper = facetimeHelperPath();
  const devices = await listAudioDevices();
  return {
    platform: fact(process.platform === 'darwin', 'FaceTime Audio control requires macOS.'),
    helper: fact(existsSync(helper), 'Run npm run setup:facetime to compile the FaceTime helper.'),
    identity: fact(identityReady(voiceConfig), 'Set a target name and E.164 phone number or email address.'),
    accessibility: fact(false, 'Grant Accessibility access to facetime-ax in System Settings > Privacy & Security > Accessibility.'),
    blackHole2ch: checkAudioDevice(devices, facetime.blackHole2chLabel || 'BlackHole 2ch', 2),
    blackHole16ch: checkAudioDevice(devices, facetime.blackHole16chLabel || 'BlackHole 16ch', 16),
  };
}

// Accessibility is enforced by the helper on every explicitly-triggered
// command. The status endpoint deliberately never spawns the helper, so its
// informational Accessibility row cannot be used as a command precondition.
export const blockingSetupFailure = (report) => Object.entries(report)
  .find(([key, value]) => key !== 'accessibility' && value.ok !== 'ok')?.[0] || null;

async function assertAvailable(config) {
  if (!await isInstanceFeatureEnabled('facetime')) {
    throw new ServerError('FaceTime Audio is disabled', { status: 409, code: 'feature-disabled' });
  }
  if (!identityReady(config)) {
    throw new ServerError('FaceTime identity is not configured', { status: 409, code: 'identity' });
  }
}

export async function run(command, config) {
  const voiceConfig = config || await getVoiceConfig();
  if (!FACETIME_COMMANDS.includes(command)) throw new ServerError('Unknown FaceTime command', { status: 400, code: 'VALIDATION_ERROR' });
  await assertAvailable(voiceConfig);
  const report = await checkSetup(voiceConfig);
  const missing = blockingSetupFailure(report);
  if (missing) throw new ServerError(`FaceTime setup incomplete: ${missing}`, { status: 409, code: missing });
  const result = await bufferedSpawn(facetimeHelperPath(), [command, voiceConfig.facetime.targetHandle, voiceConfig.facetime.targetName], { timeoutMs: FACETIME_TIMEOUT_MS });
  if (result.timedOut) throw new ServerError('FaceTime helper timed out', { status: 504, code: 'timeout' });
  const parsed = facetimeControlResultSchema.safeParse(JSON.parse(result.stdout));
  if (!parsed.success) throw new ServerError('FaceTime helper returned an invalid result', { status: 502, code: 'invalid-helper-result' });
  if (!result.success || !parsed.data.ok) {
    throw new ServerError(parsed.data.message || 'FaceTime helper failed', { status: 502, code: parsed.data.errorCode || 'helper-failed' });
  }
  return parsed.data;
}

export const probe = () => run('probe');
export const call = () => run('call');
export const answer = () => run('answer');
export const hangup = () => run('hangup');
