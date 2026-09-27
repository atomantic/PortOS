/** Fixed, reproducible benchmark rendering for approved local voice profiles (#5380, #5381). */

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
    ...profile.benchmark,
    profileRevision: profile.version,
    renderedAt: new Date().toISOString(),
    lines,
    mastering: profile.mastering,
  });
}

/**
 * Run host-specific interactive latency qualification (not speech/identity quality).
 * Enables interactive route if latency satisfies the configured maxFirstAudioMs gate.
 */
export async function benchmarkProfileInteractive(profileId, { maxFirstAudioMs = 900, signal } = {}) {
  const profile = await getVoiceProfileRequired(profileId);
  const testText = 'Hello. I am ready to speak with you.';
  const t0 = performance.now();
  const result = await synthesize(testText, {
    profileId: profile.id,
    route: 'studio', // test against the artifact without failing on disabled route
    signal,
  });
  // The public synthesis boundary returns buffered audio, so measure when it is
  // actually available rather than trusting engine estimates of first audio.
  const firstAudioMs = Math.ceil(performance.now() - t0);
  const { wavDurationMs } = await import('../../lib/wavAudioFile.js');
  if (wavDurationMs(result.wav) <= 0) {
    throw new ServerError('Interactive benchmark returned no playable audio', {
      status: 502, code: 'VOICE_BENCHMARK_NO_AUDIO',
    });
  }
  const benchmarkData = {
    ...(profile.benchmark || {}),
    profileRevision: profile.version,
    renderedAt: new Date().toISOString(),
    interactiveLatencyMs: firstAudioMs,
    similarityScore: null,
  };

  return saveProfileBenchmark(profile, benchmarkData, {
    interactive: { enabled: firstAudioMs <= maxFirstAudioMs, maxFirstAudioMs },
  });
}
