/** Fixed, reproducible benchmark rendering for approved local voice profiles (#5380, #5381). */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { synthesize } from './tts.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  getProfileForSynthesis,
  getVoiceProfileRequired,
  profileArtifactDirectory,
  saveProfileBenchmark,
} from './profiles.js';

export const VOICE_PROFILE_BENCHMARK_LINES = Object.freeze([
  { key: 'identity', text: 'This is {character}. I will keep my voice clear, steady, and recognizably mine.' },
  { key: 'articulation', text: 'At 7:15, six silver ships crossed the station with crisp, patient precision.' },
  { key: 'calm', text: 'Take a breath. We have time to look carefully before we decide what comes next.' },
  { key: 'amused', text: 'That was almost convincing. Almost is doing an impressive amount of work today.' },
  { key: 'urgent', text: 'Listen closely: move now, stay together, and do not lose sight of the exit.' },
  { key: 'long-form', text: 'I remember the promise, the weather, and the exact moment the room became quiet. That is why I am still here.' },
]);

const benchmarkLinesFor = (profile) => {
  const character = profile.label || 'this character';
  return VOICE_PROFILE_BENCHMARK_LINES.map((line) => ({
    ...line,
    text: line.text.replace('{character}', character),
  }));
};

/**
 * Render each benchmark line sequentially. Local engines are intentionally
 * serialized: Kokoro has one resident model and Piper/Qwen spawn processes,
 * so concurrency only increases contention and muddles timings.
 */
export async function renderProfileBenchmark(profileId, { signal } = {}) {
  const profile = await getProfileForSynthesis(profileId, 'studio');
  const directory = join(profileArtifactDirectory(profile.id), 'benchmarks', `v${profile.version}`);
  await mkdir(directory, { recursive: true });
  const lines = [];
  for (const [index, line] of benchmarkLinesFor(profile).entries()) {
    const result = await synthesize(line.text, {
      profileId: profile.id,
      route: 'studio',
      signal,
    });
    const filename = `${String(index + 1).padStart(2, '0')}-${line.key}.wav`;
    await writeFile(join(directory, filename), result.wav);
    lines.push({
      key: line.key,
      text: line.text,
      filename: `voice-profiles/${profile.id}/benchmarks/v${profile.version}/${filename}`,
      latencyMs: result.latencyMs,
      engine: result.engine,
      modelRevision: result.provenance?.modelRevision || profile.modelRevision,
      effectiveControls: result.provenance?.effectiveControls || { rate: null },
    });
  }
  return saveProfileBenchmark(profile, {
    profileRevision: profile.version,
    renderedAt: new Date().toISOString(),
    lines,
    mastering: profile.mastering,
  });
}

// Evidence is one-use and process-local: restarting requires a fresh playback.
// Lazy expiry keeps this user-triggered workflow free of recurring timers.
const playbackBenchmarks = new Map();
const PLAYBACK_TTL_MS = 120000;

/** Render a playable probe; rendering alone never qualifies an interactive route. */
export async function benchmarkProfileInteractive(profileId, { maxFirstAudioMs = 900, signal } = {}) {
  const profile = await getVoiceProfileRequired(profileId);
  const startedAt = performance.now();
  const result = await synthesize('Hello. I am ready to speak with you.', {
    profileId: profile.id, route: 'studio', signal,
  });
  const synthesisLatencyMs = Math.ceil(performance.now() - startedAt);
  const { wavDurationMs } = await import('../../lib/wavAudioFile.js');
  if (wavDurationMs(result.wav) <= 0) {
    throw new ServerError('Interactive benchmark returned no playable audio', {
      status: 502, code: 'VOICE_BENCHMARK_NO_AUDIO',
    });
  }
  const now = performance.now();
  for (const [id, pending] of playbackBenchmarks) {
    if (pending.expiresAt <= now || pending.profile.id === profile.id) playbackBenchmarks.delete(id);
  }
  // A bounded set even when requests complete without a playback receipt.
  if (playbackBenchmarks.size >= 100) playbackBenchmarks.delete(playbackBenchmarks.keys().next().value);
  const benchmarkId = randomUUID();
  playbackBenchmarks.set(benchmarkId, {
    profile, maxFirstAudioMs, synthesisLatencyMs, expiresAt: now + PLAYBACK_TTL_MS,
    modelRevision: result.provenance?.modelRevision || profile.modelRevision,
  });
  return { benchmarkId, profileRevision: profile.version, audioBase64: result.wav.toString('base64') };
}

/** Save only a receipt for the probe actually played by the browser. */
export async function completeProfileInteractiveBenchmark(profileId, { benchmarkId, renderRequestLatencyMs, playbackStartupMs }) {
  const pending = playbackBenchmarks.get(benchmarkId);
  if (!pending || pending.profile.id !== profileId || pending.expiresAt <= performance.now()) {
    throw new ServerError('Playback benchmark expired or does not match this profile; run it again', {
      status: 409, code: 'VOICE_BENCHMARK_RECEIPT_INVALID',
    });
  }
  playbackBenchmarks.delete(benchmarkId);
  if (!Number.isFinite(renderRequestLatencyMs) || renderRequestLatencyMs < pending.synthesisLatencyMs ||
      !Number.isFinite(playbackStartupMs) || playbackStartupMs < 0 || playbackStartupMs > 30000) {
    throw new ServerError('Playback timing does not include the rendered probe; run it again', {
      status: 400, code: 'VOICE_BENCHMARK_TIMING_INVALID',
    });
  }
  const latencyMs = Math.ceil(renderRequestLatencyMs + playbackStartupMs);
  return saveProfileBenchmark(pending.profile, {
    profileRevision: pending.profile.version,
    renderedAt: new Date().toISOString(),
    interactiveLatencyMs: latencyMs,
    similarityScore: null,
    interactiveMeasurement: {
      boundary: 'browser-playing-segmented', synthesisLatencyMs: pending.synthesisLatencyMs,
      renderRequestLatencyMs: Math.ceil(renderRequestLatencyMs), playbackStartupMs: Math.ceil(playbackStartupMs),
      modelRevision: pending.modelRevision,
    },
  }, { interactive: { enabled: latencyMs <= pending.maxFirstAudioMs, maxFirstAudioMs: pending.maxFirstAudioMs } });
}
