/** Revision-bound offline soundtrack artifacts and measured final mux evidence. */
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { createHash } from 'crypto';
import { canonicalStringify } from '../../lib/objects.js';
import { promisify } from 'util';
import { extname, join } from 'path';
import { execFile } from '../../lib/childProcess.js';
import { ServerError } from '../../lib/errorHandler.js';
import { findFfmpeg, findFfprobe, safeUnder } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/paths.js';
import { pcmToWavBuffer } from '../../lib/chiptuneRender.js';
import { measureWavAudio } from '../../lib/wavAudioFile.js';
import { CODE_ANIMATION_SAMPLE_RATE, measureSoundEvents, soundHash, soundTimeline, synthesizeSoundtrack } from '../../lib/codeAnimationSound.js';
import { muxVoLines } from '../pipeline/audioMux.js';
import { readRunArtifact, writeRunArtifact } from './projectFiles.js';

const exec = promisify(execFile);
const fail = (message, code = 'CODE_ANIMATION_SOUND_UNVERIFIED') => new ServerError(message, { status: 409, code });
const DEMUXERS = { '.wav': 'wav', '.mp3': 'mp3', '.m4a': 'mov', '.ogg': 'ogg', '.flac': 'flac', '.aac': 'aac' };

async function decode(path, timeline, signal, { demuxer, pad = false, channels = 1 } = {}) {
  const bin = await findFfmpeg();
  if (!bin) throw fail('ffmpeg is required to measure and produce a soundtrack');
  signal.throwIfAborted();
  const { stdout } = await exec(bin, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
    ...(demuxer ? ['-f', demuxer] : []), '-i', path, '-map', '0:a:0',
    ...(pad ? ['-af', 'apad'] : []), '-t', String(timeline.samples / timeline.sampleRate + (pad ? 0 : 0.1)),
    '-ar', String(timeline.sampleRate), '-ac', String(channels), '-f', 's16le', 'pipe:1'],
  { encoding: 'buffer', maxBuffer: (timeline.samples + timeline.sampleRate) * 2 * channels, timeout: 30000, signal });
  signal.throwIfAborted();
  return stdout;
}

/** No provider adapter is implied by a declaration; fail before any possible call. */
export function checkSoundConsent(audio, request) {
  if (audio.kind !== 'generated') return;
  if (!request.audioConsent || !request.audioProviderId || !request.audioModel || !(request.audioBudgetUsd > 0)) {
    throw fail('Generated audio needs explicit consent, provider/model selection and a separate positive audio budget', 'CODE_ANIMATION_AUDIO_CONSENT_REQUIRED');
  }
  throw fail('Provider-generated sound has no offline adapter yet. Stage provider output as a portable audio file.', 'CODE_ANIMATION_AUDIO_PROVIDER_UNSUPPORTED');
}

export async function produceSoundtrack({ projectId, runId, revision, signal, reserve }) {
  const { audio } = revision.manifest;
  const timeline = soundTimeline(revision.manifest);
  const binding = { revisionId: revision.id, sourceHash: revision.sourceHash, packageHash: revision.packageHash, timelineHash: timeline.hash };
  if (audio.kind === 'silence') return { ...binding, version: 1, kind: 'silence', intentional: true, timeline,
    verified: ['intentional-silence'], unverified: [] };
  if (audio.kind !== 'file' && !(audio.kind === 'procedural' && audio.version === 1)) {
    throw fail('Authored sound has no supported offline timeline or staged audio file; the film was not declared silent.', 'CODE_ANIMATION_SOUND_UNSUPPORTED');
  }
  signal.throwIfAborted();
  const channels = audio.kind === 'file' ? 2 : 1;
  await reserve(44 + timeline.samples * 2 * channels);
  let wav;
  if (audio.kind === 'procedural') wav = synthesizeSoundtrack(timeline);
  else {
    const demuxer = DEMUXERS[extname(audio.path).toLowerCase()];
    if (!demuxer) throw fail('Unsupported staged audio format', 'CODE_ANIMATION_SOUND_UNSUPPORTED');
    // Revision bytes have just been integrity checked and snapshotted; only a
    // portable asset inside that copy is decoded, never a host path from a request.
    const pcm = await decode(join(PATHS.data, revision.staged, audio.path), timeline, signal, { demuxer, pad: true, channels });
    if (pcm.length !== timeline.samples * 2 * channels) throw fail('Staged audio could not fill the film sample grid');
    const samples = Array.from({ length: channels }, () => new Float32Array(timeline.samples));
    for (let i = 0; i < timeline.samples; i += 1) {
      for (let channel = 0; channel < channels; channel += 1) samples[channel][i] = pcm.readInt16LE((i * channels + channel) * 2) / 32768;
    }
    wav = pcmToWavBuffer(samples, { sampleRate: CODE_ANIMATION_SAMPLE_RATE });
  }
  signal.throwIfAborted();
  const measured = measureWavAudio(wav);
  const events = measureSoundEvents(wav.subarray(44), timeline);
  if (!measured || measured.nonFinite || measured.frames !== timeline.samples || measured.rms === 0 || events.some(event => event.firstSample === null)) {
    throw fail('Soundtrack samples did not contain the authored sound');
  }
  const name = `sound-${revision.id}.wav`;
  const artifact = await writeRunArtifact(projectId, runId, name, wav);
  signal.throwIfAborted();
  const evidenceHash = soundHash(canonicalStringify({ ...binding, audioHash: artifact.sha256, measured, events }));
  return { ...binding, evidenceHash, version: 1, kind: audio.kind, timeline, artifact: { ...artifact, runId, name }, measured, events,
    verified: ['audio-duration', ...(events.length ? ['audio-event-placement'] : [])],
    unverified: [{ dimension: 'hearing', reason: 'Decoded samples measure placement and duration; listening quality has no reviewer.' }] };
}

export async function muxSoundtrack({ projectId, revision, soundtrack, result, signal, reserve }) {
  if (soundtrack.packageHash !== revision.packageHash || soundtrack.revisionId !== revision.id
    || soundtrack.timelineHash !== soundTimeline(revision.manifest).hash) throw fail('Sound evidence belongs to another revision', 'CODE_ANIMATION_SOUND_STALE');
  if (soundtrack.kind === 'silence') return { intentional: true, verified: ['intentional-silence'] };
  const { artifact, timeline } = soundtrack;
  const bytes = await readRunArtifact(projectId, artifact.runId, artifact.name, artifact.sha256);
  const audioPath = join(PATHS.data, artifact.relativePath);
  const videoPath = safeUnder(PATHS.videos, result.filename);
  if (!videoPath) throw fail('The render did not return a managed video');
  signal.throwIfAborted();
  // Account for the newly rendered candidate and the second-pass mux scratch.
  if (reserve) await reserve((await stat(videoPath)).size * 2 + soundtrack.artifact.bytes);
  const mux = await muxVoLines(videoPath, { voLines: [{ path: audioPath, offsetSec: 0 }], signal });
  if (!mux.ok) throw fail(`Soundtrack mux failed: ${mux.reason}`);
  signal.throwIfAborted();
  const probe = await findFfprobe();
  if (!probe) throw fail('ffprobe is required to verify the muxed soundtrack');
  const { stdout } = await exec(probe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,duration', '-of', 'json', videoPath],
    { timeout: 10000, maxBuffer: 65536, signal });
  const stream = JSON.parse(stdout).streams?.[0];
  const duration = Number(stream?.duration);
  const expected = timeline.samples / timeline.sampleRate;
  if (!stream || !Number.isFinite(duration) || Math.abs(duration - expected) > 0.06) throw fail('Muxed audio stream duration did not match the film');
  const channels = soundtrack.measured.channels;
  const decoded = await decode(videoPath, timeline, signal, { channels });
  if (Math.abs(decoded.length / 2 / channels / timeline.sampleRate - expected) > 0.06) throw fail('Decoded mux duration did not match the film');
  const events = measureSoundEvents(decoded, timeline);
  const reference = measureSoundEvents(bytes.subarray(44), timeline);
  if (events.some((event, index) => event.firstSample === null || Math.abs(event.firstSeconds - reference[index].firstSeconds) > 0.02)) {
    throw fail('Decoded mux did not preserve authored event placement');
  }
  // Also reject a silent decode for file audio, which has no synthetic events.
  let peak = 0;
  for (let i = 0; i < decoded.length; i += 2) peak = Math.max(peak, Math.abs(decoded.readInt16LE(i)) / 32768);
  if (!peak) throw fail('Muxed audio decoded to silence');
  const videoDigest = createHash('sha256');
  for await (const chunk of createReadStream(videoPath, { signal })) videoDigest.update(chunk);
  signal.throwIfAborted();
  const videoHash = videoDigest.digest('hex');
  return { version: 1, videoHash, evidenceHash: soundHash(canonicalStringify({ packageHash: revision.packageHash, audioHash: artifact.sha256, videoHash, decodedHash: soundHash(decoded) })), revisionId: revision.id, packageHash: revision.packageHash, audioHash: soundHash(bytes),
    timelineHash: timeline.hash, stream, decodedSamples: decoded.length / 2 / channels, decodedChannels: channels, decodedDurationSeconds: decoded.length / 2 / channels / timeline.sampleRate,
    decodedHash: soundHash(decoded), peak, events, verified: ['audio-stream', 'audio-duration', ...(events.length ? ['audio-event-placement'] : [])],
    unverified: soundtrack.unverified };
}
