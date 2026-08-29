/**
 * Pure device/format helpers for the FaceTime call-host page.
 *
 * The page itself is unavoidably impure — real devices, a real AudioWorklet, a
 * real Web Lock — so everything that can be decided from plain data lives here
 * instead: which device to open, whether the browser can do the job at all,
 * and the PCM conversion the server expects.
 *
 * The whole module fails CLOSED by construction: an absent capability, an
 * absent device, and a device that is present but wrong all produce a specific
 * message rather than a best guess, because a bridge that half-works drops the
 * user's call audio on the floor silently.
 */

export const CALL_AUDIO_SAMPLE_RATE = 16_000;
/** One Web Lock so a second tab cannot double-answer the same call. */
export const CALL_HOST_LOCK = 'portos-facetime-call-host';
/** ~20 ms of 16 kHz mono — small enough to endpoint on, big enough not to flood. */
export const CALL_FRAME_SAMPLES = 320;

// Browser APIs with no fallback worth having. `setSinkId` is what routes the
// reply into BlackHole 2ch; without it the assistant would talk to the room
// instead of into the call.
const REQUIRED_APIS = Object.freeze([
  { name: 'MediaStreamTrackProcessor', test: (scope) => typeof scope?.MediaStreamTrackProcessor === 'function' },
  { name: 'MediaStreamTrackGenerator', test: (scope) => typeof scope?.MediaStreamTrackGenerator === 'function' },
  { name: 'AudioWorklet', test: (scope) => typeof scope?.AudioWorkletNode === 'function' },
  { name: 'mediaDevices.enumerateDevices', test: (scope) => typeof scope?.navigator?.mediaDevices?.enumerateDevices === 'function' },
  { name: 'HTMLMediaElement.setSinkId', test: (scope) => typeof scope?.HTMLMediaElement?.prototype?.setSinkId === 'function' },
  { name: 'navigator.locks', test: (scope) => typeof scope?.navigator?.locks?.request === 'function' },
]);

/** Every required API this browser is missing, in the order they are listed. */
export function missingCallHostApis(scope = globalThis) {
  return REQUIRED_APIS.filter((api) => !api.test(scope)).map((api) => api.name);
}

const normalize = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Find a device by its human label.
 *
 * Matched exactly (after trimming and case-folding) rather than by substring:
 * "BlackHole 16ch" contains "BlackHole 1", and picking the wrong virtual
 * device is indistinguishable from a dead call.
 */
export function findAudioDevice(devices, label, kind) {
  if (!Array.isArray(devices)) return null;
  const wanted = normalize(label);
  if (!wanted) return null;
  return devices.find((device) => normalize(device?.label) === wanted && (!kind || device?.kind === kind)) || null;
}

/**
 * Why the bridge cannot start, or `null` when it can.
 *
 * An empty device list is reported as a permission problem, not as a missing
 * device: a browser that has not been granted microphone access returns
 * unlabeled entries, and telling the user to reinstall BlackHole then would
 * send them to fix the wrong thing.
 *
 * `outputLabel` is optional: capture mode only listens (BlackHole 16ch in),
 * it never plays a reply back into anything, so it has no BlackHole 2ch
 * requirement. Omitting it skips the output check entirely rather than
 * reporting a device named "undefined" as missing.
 */
export function describeDeviceProblem(devices, { inputLabel, outputLabel } = {}) {
  if (!Array.isArray(devices)) return 'Could not read this Mac’s audio devices.';
  if (!devices.some((device) => normalize(device?.label))) {
    return 'Grant this tab microphone access so it can see the audio devices by name.';
  }
  if (!findAudioDevice(devices, inputLabel, 'audioinput')) {
    return `No audio input named “${inputLabel}”. Install BlackHole and set FaceTime’s output to it.`;
  }
  if (outputLabel && !findAudioDevice(devices, outputLabel, 'audiooutput')) {
    return `No audio output named “${outputLabel}”. Install BlackHole and set FaceTime’s microphone to it.`;
  }
  return null;
}

/** Average N planar channels into one. BlackHole 16ch carries the call on all of them. */
export function downmixToMono(channels) {
  if (!channels?.length) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const length = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[index];
    mono[index] = sum / channels.length;
  }
  return mono;
}

/**
 * Resample to 16 kHz by linear interpolation.
 *
 * Whisper wants 16 kHz and the devices run at 48 kHz. Linear is enough for
 * speech at a 3:1 ratio and costs nothing; anything fancier would need a
 * filter bank in an AudioWorklet's render quantum budget.
 */
export function resampleTo16k(samples, fromRate) {
  if (!samples?.length || !fromRate) return new Float32Array(0);
  if (fromRate === CALL_AUDIO_SAMPLE_RATE) return Float32Array.from(samples);
  const ratio = fromRate / CALL_AUDIO_SAMPLE_RATE;
  const length = Math.floor(samples.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

/** Float -1..1 → Int16, clamped. The wire format the server endpoints on. */
export function floatToInt16(samples) {
  const output = new Int16Array(samples?.length || 0);
  for (let index = 0; index < output.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    output[index] = Math.round(clamped * 32767);
  }
  return output;
}

/** 0..1 level for the input meter. */
export function rmsLevel(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / samples.length);
}

/** One second of a 440 Hz tone, for confirming the call can hear PortOS. */
export function buildTestTone(sampleRate = CALL_AUDIO_SAMPLE_RATE, seconds = 1, frequency = 440) {
  const samples = new Float32Array(Math.max(0, Math.round(sampleRate * seconds)));
  for (let index = 0; index < samples.length; index += 1) {
    // Faded in and out so the tone cannot click through the call.
    const envelope = Math.min(1, Math.min(index, samples.length - index) / (sampleRate * 0.01));
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.3 * envelope;
  }
  return samples;
}
