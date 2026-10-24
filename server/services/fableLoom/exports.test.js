import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../../lib/mockPathsDataRoot.js';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { readZipArchive } from '../../lib/zipArchive.js';
import * as ffmpeg from '../../lib/ffmpeg.js';
import { findFfmpeg, findFfprobe, runFfmpegProcess } from '../../lib/ffmpeg.js';
import {
  FABLELOOM_EXPORT_LIMITS, inspectFableLoomExportCharacters,
} from '../../lib/fableLoomExport.js';
import { execFileSync } from '../../lib/childProcess.js';

vi.mock('../../lib/paths.js', async original => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-fableloom-export-'),
}));
vi.mock('./records.js', () => ({ getLoom: vi.fn() }));
vi.mock('../videoGen/history.js', () => ({ loadHistory: vi.fn() }));
vi.mock('../universeBuilder.js', () => ({ getUniverse: vi.fn() }));
vi.mock('../voice/profiles.js', () => ({ listVoiceProfiles: vi.fn() }));
vi.mock('./index.js', () => ({}));
vi.mock('./shotRuns.js', () => ({}));

import { PATHS } from '../../lib/paths.js';
import { getLoom } from './records.js';
import { loadHistory } from '../videoGen/history.js';
import { getUniverse } from '../universeBuilder.js';
import { listVoiceProfiles } from '../voice/profiles.js';
import * as media from './exportMedia.js';
import {
  __testing, startFableLoomExport, getFableLoomExport, getFableLoomExportDownload,
} from './exports.js';
import routes from '../../routes/fableLoom.js';

const owned = ownTestBodies(vitestIt);
const it = owned.it;
const bin = await findFfmpeg();
const probe = await findFfprobe();
const canPrepareVideo = Boolean(bin && probe);
const videoIt = canPrepareVideo ? it : vitestIt.skip;
const posixIt = process.platform === 'win32' ? vitestIt.skip : it;
const privateMarker = 'EXAMPLE_PRIVATE_SENTINEL';
const sourcePath = '/example-private/source';
let sourceImage;
let sourceVideo;
let loom;
const jobIds = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const recordFile = id => join(PATHS.data, 'cache/fableloom-exports', id, 'job.json');
const app = () => express().use(express.json()).use('/api/fableloom', routes).use(errorMiddleware);
const conditioning = kind => ({
  version: 1, status: 'locked', capability: { kind, backend: 'example-provider', modelId: 'Example/Model' },
  render: { provider: 'example-provider', modelId: 'Example/Model', parameters: { seed: 42, secret: privateMarker } },
  adapters: [{ filename: sourcePath }], assets: [{ filename: sourcePath }],
  compiledPrompt: privateMarker, instanceId: privateMarker,
});
function episode(id, number = 1) {
  const nodes = [
    { id: id + '-start', title: 'At the gate', prose: 'A traveller reaches a quiet gate.',
      playbackMode: 'decision', audienceConnection: 'connected', protagonistPresence: 'offscreen',
      isEnding: false, endingLabel: '', image: 'still.png',
      visualCanon: { storyboardImageApproved: true }, visualConditioning: conditioning('image'),
      videoHistoryId: 'entry-record',
      playbackAssets: { entryVideoHistoryId: 'entry-record', holdLoopVideoHistoryIds: ['hold-record'],
        exitByTransition: { choose: 'exit-record' },
        visualConditioningByAsset: Object.fromEntries(['entry-record', 'hold-record', 'exit-record'].map(key => [key, conditioning('video')])),
        audioOccupancy: { 'hold-record': { durationMs: 1000, effects: [
          { startMs: 0, endMs: 500, blocking: false, name: privateMarker },
        ] } } },
      interactionWindow: { enabled: true, protagonistCharacterId: 'example-character', protagonistPresence: 'offscreen' },
      transitions: [
        { id: 'choose', intent: 'Open', triggers: ['open'], description: 'Open the gate.', targetNodeId: id + '-end' },
        { id: 'leave', intent: 'Leave', triggers: ['leave'], description: 'Take another path.', targetNodeId: id + '-end' },
      ], sessions: [privateMarker], apiKey: privateMarker },
    { id: id + '-end', title: 'Home', prose: 'The traveller finds a home.',
      playbackMode: 'cut', audienceConnection: 'connected', protagonistPresence: 'offscreen',
      isEnding: true, endingLabel: 'Home', image: 'still.png', videoHistoryId: 'entry-record',
      visualCanon: { storyboardImageApproved: true }, visualConditioning: conditioning('image'),
      playbackAssets: { entryVideoHistoryId: 'entry-record', visualConditioningByAsset: { 'entry-record': conditioning('video') } },
      transitions: [] },
  ];
  return { id, number, title: 'Example episode', synopsis: 'A journey.', startNodeId: nodes[0].id, nodes,
    storyOutline: { startKey: nodes[0].id, validation: { status: 'valid' },
      scenes: nodes.map(node => ({ ...node, key: node.id, summary: node.title,
        transitions: node.transitions.map(t => ({ ...t, targetKey: t.targetNodeId })) })) } };
}

async function begin(options = {}) {
  const result = await startFableLoomExport(loom.id, options);
  jobIds.push(result.jobId);
  return result.jobId;
}
async function terminal(id) {
  let result;
  await vi.waitFor(async () => {
    result = await getFableLoomExport(loom.id, id);
    expect(['completed', 'failed']).toContain(result.status);
  }, { timeout: 10_000, interval: 20 });
  return result;
}
async function archive(id) {
  const result = await terminal(id);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed' });
  const artifact = await getFableLoomExportDownload(loom.id, id);
  try {
    const bytes = await readFile(artifact.path);
    return { bytes, files: new Map(readZipArchive(bytes).map(e => [e.name, e.read()])) };
  } finally { artifact.release(); }
}

const packageSentinels = [
  privateMarker, sourcePath, 'SECRET_TOKEN_SENTINEL', 'SESSION_TRANSCRIPT_SENTINEL',
  'SECRET_CAST_SENTINEL', 'SECRET_ENGINE_SENTINEL', 'kokoro:SECRET_PRESET',
  'SECRET_APPROVED_AT', '/example-private/checkpoint', 'example-voice',
];
function assertPackageClean(packed) {
  for (const marker of packageSentinels) {
    expect(packed.bytes.includes(Buffer.from(marker)), marker).toBe(false);
    for (const bytes of packed.files.values()) expect(bytes.includes(Buffer.from(marker)), marker).toBe(false);
  }
}
function approvedCharacter(overrides = {}) {
  return {
    id: 'example-character', name: 'Ada Example',
    personality: 'Calm and precise.', speechAccent: 'Neutral example accent.',
    speechPattern: 'Short sentences.', mannerisms: 'Pauses before answers.',
    background: privateMarker, secrets: 'SECRET_TOKEN_SENTINEL', psychology: privateMarker,
    voiceId: 'kokoro:SECRET_PRESET', prompt: privateMarker,
    adapters: [{ filename: sourcePath }], loras: [sourcePath], imageRefs: [sourcePath],
    sessions: ['SESSION_TRANSCRIPT_SENTINEL'],
    voiceCanon: {
      version: 2, approved: true, sourcePolicy: 'designed',
      description: 'Warm mid register.', defaultDelivery: 'Measured.',
      emotionalRange: ['steady'], avoid: ['never shout'],
      pronunciations: [{ term: 'Fable', pronunciation: 'FAY-bul', recordingPath: sourcePath }],
      recordingPath: sourcePath,
    },
    ...overrides,
  };
}
function useCast(characters = [approvedCharacter()]) {
  loom.protagonistCharacterId = 'example-character';
  getUniverse.mockResolvedValue({
    id: 'example-universe',
    characters: [...characters, { id: 'unbound-extra', name: 'SECRET_CAST_SENTINEL', personality: privateMarker }],
  });
}
async function writeVoiceReference(bytes, filename = 'reference.wav') {
  const dir = join(PATHS.voiceProfiles, 'example-voice', 'source');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), bytes);
  return hash(bytes);
}
function voiceProfile({ sha256, filename = 'reference.wav', id = 'example-voice', kind = 'designed', sourceAssets } = {}) {
  return {
    id, kind, engine: 'SECRET_ENGINE_SENTINEL', voiceId: 'kokoro:SECRET_PRESET',
    binding: { universeId: 'example-universe', characterId: 'example-character' },
    approval: { status: 'approved', approvedAt: 'SECRET_APPROVED_AT' },
    routes: { interactive: { enabled: true } },
    inference: { checkpointPath: '/example-private/checkpoint' },
    sourceAssets: sourceAssets || [{
      filename, sha256, transcript: 'SESSION_TRANSCRIPT_SENTINEL',
      performerConsentConfirmed: false, licensePosture: 'generated-original-voice', path: sourcePath,
    }],
  };
}
async function expectVoiceRefusal(profiles, code, options = { includeCharacters: true, includeVoice: true }) {
  listVoiceProfiles.mockResolvedValue(profiles);
  const result = await terminal(await begin({ episodeIds: ['episode-one'], ...options }));
  expect(result).toMatchObject({ status: 'failed', error: { code: 'EXPORT_VALIDATION_FAILED' } });
  expect(result.findings).toContainEqual(expect.objectContaining({ code, severity: 'error' }));
  expect(result).not.toHaveProperty('downloadUrl');
  expect(JSON.stringify(result)).not.toContain(sourcePath);
  expect(JSON.stringify(result)).not.toContain('SESSION_TRANSCRIPT_SENTINEL');
  expect(JSON.stringify(result)).not.toContain('example-voice');
  expect(JSON.stringify(result)).not.toContain('/example-private/checkpoint');
  await expect(stat(join(PATHS.data, 'cache/fableloom-exports', jobIds.at(-1), 'package.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  return result;
}

beforeAll(async () => {
  await mkdir(PATHS.images, { recursive: true });
  await mkdir(PATHS.videos, { recursive: true });
  sourceImage = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#345678' } })
    .withMetadata({ exif: { IFD0: { ImageDescription: privateMarker + sourcePath } } }).png().toBuffer();
  await writeFile(join(PATHS.images, 'still.png'), sourceImage);
  if (canPrepareVideo) {
    const output = join(PATHS.videos, 'independent-name.mp4');
    const encoded = await runFfmpegProcess({ bin, timeoutMs: 10_000, args: [
      '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=10:d=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1',
      '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p',
      '-bsf:v', 'h264_metadata=sei_user_data=0123456789abcdef0123456789abcdef+' + privateMarker,
      '-metadata', 'comment=' + privateMarker + sourcePath, output,
    ] });
    expect(encoded).toEqual({ ok: true });
    sourceVideo = await readFile(output);
    expect(sourceVideo.indexOf(privateMarker)).not.toBe(sourceVideo.lastIndexOf(privateMarker));
  }
});
beforeEach(async () => {
  await __testing.drain();
  vi.restoreAllMocks();
  loom = { id: 'example-loom', name: 'The quiet gate', logline: 'An unexpected journey.',
    participationMode: 'protagonist', audienceCommunicationMedium: 'Walkie-talkie', format: 'prose',
    universeId: 'example-universe', productionStatus: { deliveryApprovedAt: '2026-01-01T00:00:00.000Z' },
    episodes: [episode('episode-one'), episode('episode-two', 2)],
    sessionTranscripts: privateMarker, peerId: privateMarker, providerConfig: { apiKey: privateMarker } };
  getLoom.mockImplementation(async id => id === loom.id || id === 'another-loom' ? loom : null);
  getUniverse.mockResolvedValue({ characters: [{ id: 'example-character' }] });
  listVoiceProfiles.mockResolvedValue([]);
  await rm(PATHS.voiceProfiles, { recursive: true, force: true });
  loadHistory.mockResolvedValue(['entry-record', 'hold-record', 'exit-record'].map(id => ({
    id, filename: 'independent-name.mp4', absolutePath: sourcePath, prompt: privateMarker, apiKey: privateMarker,
  })));
  jobIds.length = 0;
  await rm(join(PATHS.data, 'cache/fableloom-exports'), { recursive: true, force: true });
});
afterEach(async () => { await __testing.drain(); vi.restoreAllMocks(); });
afterAll(async () => { await owned.drain(); await __testing.drain(); cleanupTempDataRoots(); });

describe('portable FableLoom export boundary', () => {
  videoIt('exports selected episodes deterministically, strips private data and embedded tags, and serves the ZIP', async () => {
    const started = await request(app()).post('/api/fableloom/example-loom/export').send({ episodeIds: ['episode-two'] });
    expect(started.status).toBe(202);
    jobIds.push(started.body.jobId);
    const first = await archive(started.body.jobId);
    const second = await archive(await begin({ episodeIds: ['episode-two'] }));
    expect(second.bytes.equals(first.bytes)).toBe(true);
    const manifest = JSON.parse(first.files.get('manifest.json'));
    expect(manifest).toMatchObject({ schemaVersion: '1.0.0', runtimeVersion: '1.0.0',
      loom: { name: 'The quiet gate', episodes: [{ id: 'episode-two' }] } });
    expect(manifest.loom.episodes).toHaveLength(1);
    expect(manifest.characters).toBeUndefined();
    expect([...first.files.keys()].some(name => name.startsWith('characters/'))).toBe(false);
    const defaultProvenance = JSON.parse(first.files.get('provenance.json'));
    expect(defaultProvenance.characters).toBeUndefined();
    expect(defaultProvenance.voices).toBeUndefined();
    const defaultReadme = first.files.get('README.md').toString();
    expect(defaultReadme).toContain('does not grant PortOS access');
    expect(defaultReadme).toContain('Voice reference audio was not included');
    expect(defaultReadme).toContain('Your host owns free-text');
    expect(listVoiceProfiles).not.toHaveBeenCalled();
    const [start, end] = manifest.loom.episodes[0].nodes;
    expect(start.playbackAssets.holds[0]).toMatchObject({ loopable: true, durationMs: 1000,
      audioOccupancy: { safeForLiveVoice: true } });
    expect(start.playbackAssets.exits.choose).toMatchObject({ loopable: false, durationMs: 1000 });
    expect(end).toMatchObject({ isEnding: true, endingLabel: 'Home' });
    expect(first.files.has('runtime-v1.md')).toBe(true);
    const mediaFiles = [...first.files].filter(([name]) => name.startsWith('media/'));
    expect(mediaFiles).toHaveLength(2);
    for (const [name, bytes] of mediaFiles) expect(name).toContain(hash(bytes));
    for (const bytes of [first.bytes, ...first.files.values()]) {
      expect(bytes.includes(Buffer.from(privateMarker))).toBe(false);
      expect(bytes.includes(Buffer.from(sourcePath))).toBe(false);
    }
    expect(await readFile(join(PATHS.images, 'still.png'))).toEqual(sourceImage);
    expect(await readFile(join(PATHS.videos, 'independent-name.mp4'))).toEqual(sourceVideo);
    const status = await request(app()).get('/api/fableloom/example-loom/export/' + started.body.jobId);
    expect(status.body).toMatchObject({ status: 'completed', sizeReport: { mediaFiles: 2, archiveBytes: first.bytes.length } });
    const download = await request(app()).get(status.body.downloadUrl);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/zip/);
    expect(download.headers['content-disposition']).toMatch(/fableloom-[a-f0-9]{16}-v1.zip/);
    const wrongLoom = await request(app()).get('/api/fableloom/another-loom/export/' + started.body.jobId);
    expect(wrongLoom.status).toBe(404);
    await expect(getFableLoomExportDownload('another-loom', started.body.jobId)).rejects.toMatchObject({ status: 404 });
    const removed = await getFableLoomExportDownload(loom.id, started.body.jobId);
    try { await rm(removed.path); } finally { removed.release(); }
    const missingArtifact = await request(app()).get(status.body.downloadUrl);
    expect([missingArtifact.status, missingArtifact.body.code]).toEqual([409, 'EXPORT_ARTIFACT_INVALID']);
    expect(missingArtifact.text).not.toContain(removed.path);
  });

  videoIt('encodes bounded web media, normalizes audio, retains roles and reuses content/profile cache', async () => {
    const source = join(PATHS.videos, 'profile-fixture.mp4');
    expect(await runFfmpegProcess({ bin, timeoutMs: 10_000, args: [
      '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1600x900:r=15:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-af', 'volume=0.1',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-threads', '1', source,
    ] })).toEqual({ ok: true });
    const original = await readFile(source);
    loadHistory.mockResolvedValue(['entry-record', 'hold-record', 'exit-record'].map(id => ({ id, filename: 'profile-fixture.mp4' })));
    const encode = vi.spyOn(ffmpeg, 'runFfmpegProcess');
    const options = { episodeIds: ['episode-one'], mediaProfile: 'web-720p', includeWebm: true };
    const firstId = await begin(options);
    const first = await archive(firstId);
    const firstCount = encode.mock.calls.length;
    const repeat = await archive(await begin(options));
    expect(repeat.bytes).toEqual(first.bytes);
    expect(encode).toHaveBeenCalledTimes(firstCount);
    // Three distinct history IDs with identical source content encode only once.
    expect(encode.mock.calls.filter(([args]) => args.args.includes('libx264'))).toHaveLength(1);
    const manifest = JSON.parse(first.files.get('manifest.json'));
    const assets = manifest.loom.episodes[0].nodes[0].playbackAssets;
    expect(assets.holds[0]).toMatchObject({ loopable: true, audioOccupancy: { durationMs: 1000,
      effects: [{ startMs: 0, endMs: 500 }], safeForLiveVoice: true } });
    expect(assets.exits.choose.file).toBe(assets.entry.file);
    expect(first.files.has(assets.entry.poster.file)).toBe(true);
    expect(assets.entry.alternatives).toHaveLength(1);
    const inspect = (file) => JSON.parse(execFileSync(probe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 10_000 }).toString());
    const encodedFile = join(PATHS.videos, 'packaged.mp4');
    await writeFile(encodedFile, first.files.get(assets.entry.file));
    const measured = inspect(encodedFile);
    expect(measured.streams.find(s => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', width: 1280, height: 720 });
    expect(measured.streams.find(s => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac', sample_rate: '48000' });
    expect(Number(measured.streams.find(s => s.codec_type === 'video').bit_rate)).toBeLessThanOrEqual(2_000_000);
    expect(Number(measured.streams.find(s => s.codec_type === 'audio').bit_rate)).toBeLessThanOrEqual(128_000);
    const analyzed = await runFfmpegProcess({ bin, timeoutMs: 10_000, returnStderr: true, stderrTailBytes: 8192,
      args: ['-nostdin', '-i', encodedFile, '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'] });
    expect(analyzed.ok).toBe(true);
    const level = JSON.parse(analyzed.stderr.slice(analyzed.stderr.lastIndexOf('{'), analyzed.stderr.lastIndexOf('}') + 1));
    expect(Math.abs(Number(level.input_i) + 16)).toBeLessThan(1);
    expect(Number(level.input_tp)).toBeLessThanOrEqual(-1.4);
    const webm = join(PATHS.videos, 'packaged.webm');
    await writeFile(webm, first.files.get(assets.entry.alternatives[0].file));
    expect(inspect(webm).streams.map(s => s.codec_name)).toEqual(['vp9', 'opus']);
    const provenance = JSON.parse(first.files.get('provenance.json'));
    expect(provenance.assets.find(a => a.role === 'entry')).toMatchObject({ bytes: first.files.get(assets.entry.file).length,
      encoding: { sourceSha256: hash(original), profile: { id: 'web-720p', videoKbps: 2000, includeWebm: true },
        encoder: { ffmpeg: expect.any(String), buildHash: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    const mediaFiles = [...first.files].filter(([name]) => name.startsWith('media/'));
    for (const [name, bytes] of mediaFiles) expect(name).toContain(hash(bytes));
    expect((await terminal(firstId)).sizeReport.mediaBytes).toBe(mediaFiles.reduce((n, [, bytes]) => n + bytes.length, 0));
    const changed = await archive(await begin({ ...options, mediaProfile: 'web-1080p', includeWebm: false }));
    const changedAssets = JSON.parse(changed.files.get('manifest.json')).loom.episodes[0].nodes[0].playbackAssets;
    expect(changedAssets.entry.file).not.toBe(assets.entry.file);
    expect(changedAssets.entry).not.toHaveProperty('alternatives');
    expect(encode.mock.calls.filter(([args]) => args.args.includes('libx264'))).toHaveLength(2);
    expect(await readFile(source)).toEqual(original);
  });

  videoIt('preserves silent soundtracks and clips without audio in web profiles', async () => {
    const outcomes = [];
    const realRun = ffmpeg.runFfmpegProcess;
    vi.spyOn(ffmpeg, 'runFfmpegProcess').mockImplementation(async options => {
      const result = await realRun(options);
      outcomes.push({ ok: result.ok, reason: result.reason });
      return result;
    });
    const silentId = await begin({ episodeIds: ['episode-one'], mediaProfile: 'web-720p' });
    expect((await terminal(silentId)).status, JSON.stringify(outcomes)).toBe('completed');
    const silent = await archive(silentId);
    const silentAssets = JSON.parse(silent.files.get('manifest.json')).loom.episodes[0].nodes[0].playbackAssets;
    const output = join(PATHS.videos, 'without-audio.mp4');
    expect(await runFfmpegProcess({ bin, timeoutMs: 10_000, args: ['-nostdin', '-y', '-v', 'error',
      '-i', join(PATHS.videos, 'independent-name.mp4'), '-an', '-c:v', 'copy', output] })).toEqual({ ok: true });
    loadHistory.mockResolvedValue(['entry-record', 'hold-record', 'exit-record'].map(id => ({ id, filename: 'without-audio.mp4' })));
    const noAudio = await archive(await begin({ episodeIds: ['episode-one'], mediaProfile: 'web-720p' }));
    const noAudioAssets = JSON.parse(noAudio.files.get('manifest.json')).loom.episodes[0].nodes[0].playbackAssets;
    expect(noAudioAssets.entry.file).not.toBe(silentAssets.entry.file);
    await writeFile(output, noAudio.files.get(noAudioAssets.entry.file));
    const streams = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_streams', '-of', 'json', output], { timeout: 10_000 }).toString()).streams;
    expect(streams.map(stream => stream.codec_type)).toEqual(['video']);
    expect(noAudioAssets.holds[0].audioOccupancy).toEqual(silentAssets.holds[0].audioOccupancy);
  });

  videoIt('normalizes short non-silent audio without padding its duration', async () => {
    const source = join(PATHS.videos, 'short-sfx.mp4');
    expect(await runFfmpegProcess({ bin, timeoutMs: 10_000, args: [
      '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=10:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.2', '-af', 'volume=0.1',
      '-c:v', 'libx264', '-c:a', 'aac', '-threads', '1', source,
    ] })).toEqual({ ok: true });
    loadHistory.mockResolvedValue(['entry-record', 'hold-record', 'exit-record'].map(id => ({ id, filename: 'short-sfx.mp4' })));
    const result = await archive(await begin({ episodeIds: ['episode-one'], mediaProfile: 'web-720p' }));
    const assets = JSON.parse(result.files.get('manifest.json')).loom.episodes[0].nodes[0].playbackAssets;
    expect(assets.entry.durationMs).toBe(1000);
    const output = join(PATHS.videos, 'short-normalized.mp4');
    await writeFile(output, result.files.get(assets.entry.file));
    const streams = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_streams', '-of', 'json', output], { timeout: 10_000 }).toString()).streams;
    const audio = streams.find(stream => stream.codec_type === 'audio');
    expect(Number(audio.duration)).toBeGreaterThanOrEqual(0.2);
    expect(Number(audio.duration)).toBeLessThan(0.25);
    const analyzed = await runFfmpegProcess({ bin, timeoutMs: 10_000, returnStderr: true, stderrTailBytes: 8192,
      args: ['-nostdin', '-i', output, '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'] });
    expect(analyzed.ok).toBe(true);
    const level = JSON.parse(analyzed.stderr.slice(analyzed.stderr.lastIndexOf('{'), analyzed.stderr.lastIndexOf('}') + 1));
    expect(Number(level.input_tp)).toBeGreaterThan(-3);
    expect(Number(level.input_tp)).toBeLessThan(0);
  });

  videoIt('measures retained streams when discarded subtitle tracks outlast picture and audio', async () => {
    const subtitle = join(PATHS.videos, 'extended.srt');
    await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:03,000\nExample subtitle\n');
    const source = join(PATHS.videos, 'extended-subtitle.mp4');
    expect(await runFfmpegProcess({ bin, timeoutMs: 10_000, args: ['-nostdin', '-y', '-v', 'error',
      '-i', join(PATHS.videos, 'independent-name.mp4'), '-i', subtitle, '-map', '0', '-map', '1:0',
      '-c', 'copy', '-c:s', 'mov_text', source] })).toEqual({ ok: true });
    const measured = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_streams', '-of', 'json', source], { timeout: 10_000 }).toString());
    expect(Number(measured.streams.find(stream => stream.codec_type === 'subtitle').duration)).toBe(3);
    loadHistory.mockResolvedValue(['entry-record', 'hold-record', 'exit-record'].map(id => ({ id, filename: 'extended-subtitle.mp4' })));
    for (const mediaProfile of ['source', 'web-720p']) {
      const result = await archive(await begin({ episodeIds: ['episode-one'], mediaProfile }));
      const assets = JSON.parse(result.files.get('manifest.json')).loom.episodes[0].nodes[0].playbackAssets;
      expect(assets.entry.durationMs).toBe(1000);
      expect(assets.holds[0].audioOccupancy.durationMs).toBe(1000);
      const output = join(PATHS.videos, 'retained.mp4');
      await writeFile(output, result.files.get(assets.entry.file));
      const streams = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_streams', '-of', 'json', output], { timeout: 10_000 }).toString()).streams;
      expect(streams.map(stream => stream.codec_type)).toEqual(['video', 'audio']);
    }
  });

  videoIt('drains cancelled and failed encoder children before exposing terminal failure without an artifact', async () => {
    const realRun = ffmpeg.runFfmpegProcess;
    const started = Promise.withResolvers();
    let drained = false;
    vi.spyOn(ffmpeg, 'runFfmpegProcess').mockImplementation(async options => {
      const pending = realRun({ ...options, args: ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
        'color=c=blue:s=32x32:r=10', '-f', 'null', '-'] });
      started.resolve();
      const result = await pending;
      drained = true;
      return result;
    });
    const id = await begin({ episodeIds: ['episode-one'], mediaProfile: 'web-720p' });
    await started.promise;
    const cancelled = await request(app()).delete(`/api/fableloom/example-loom/export/${id}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'failed', error: { code: 'EXPORT_CANCELLED' } });
    expect(drained).toBe(true);
    expect(cancelled.body).not.toHaveProperty('downloadUrl');
    await expect(stat(join(PATHS.data, 'cache/fableloom-exports', id, 'package.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(PATHS.data, 'cache/fableloom-exports', id, 'work'))).rejects.toMatchObject({ code: 'ENOENT' });
    vi.spyOn(ffmpeg, 'runFfmpegProcess').mockImplementation(options => realRun({ ...options,
      args: ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=32x32:d=0.1', '-c:v', 'not-an-encoder', '-f', 'null', '-'] }));
    const failedId = await begin({ episodeIds: ['episode-one'], mediaProfile: 'web-720p' });
    expect(await terminal(failedId)).toMatchObject({ status: 'failed', error: { code: 'EXPORT_TRANSCODE_FAILED' } });
    await expect(getFableLoomExportDownload(loom.id, failedId)).rejects.toMatchObject({ code: 'EXPORT_NOT_READY' });
    await expect(stat(join(PATHS.data, 'cache/fableloom-exports', failedId, 'package.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  videoIt('refuses unapproved media by default and records draft flags only after explicit opt-in', async () => {
    const node = loom.episodes[0].nodes[0];
    node.visualCanon.storyboardImageApproved = false;
    node.playbackAssets.visualConditioningByAsset['asset-' + node.id + '-still'] = node.visualConditioning;
    node.visualConditioning = conditioning('video');
    node.visualConditioning.render.provider = 'example-video-provider';
    const refused = await terminal(await begin());
    expect(refused).toMatchObject({ status: 'failed', error: { code: 'EXPORT_VALIDATION_FAILED' } });
    expect(refused.findings).toContainEqual(expect.objectContaining({ gate: 'approval', severity: 'error' }));
    expect(refused).not.toHaveProperty('downloadUrl');
    const draft = await archive(await begin({ allowDraft: true }));
    const provenance = JSON.parse(draft.files.get('provenance.json'));
    expect(provenance.assets).toContainEqual(expect.objectContaining({
      role: 'still', approved: false, draftFlags: ['unapproved'], parametersHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(provenance.assets.every(a => a.provider === 'example-provider')).toBe(true);
  });

  it('keeps structural and required-media failures blocking under allowDraft', async () => {
    loom.episodes[0].nodes[0].transitions[0].targetNodeId = 'missing-node';
    const graph = await terminal(await begin({ allowDraft: true }));
    expect(graph).toMatchObject({ status: 'failed', error: { code: 'EXPORT_VALIDATION_FAILED' } });
    expect(graph.findings).toContainEqual(expect.objectContaining({ gate: 'graph', code: 'DANGLING_TRANSITION' }));
    loom.episodes = [episode('episode-one')];
    loom.episodes[0].nodes[0].image = null;
    const missing = await terminal(await begin({ allowDraft: true }));
    expect(missing.findings).toContainEqual(expect.objectContaining({ gate: 'media', code: 'EXPORT_MEDIA_MISSING', severity: 'error' }));
    await expect(getFableLoomExportDownload(loom.id, jobIds.at(-1))).rejects.toMatchObject({ code: 'EXPORT_NOT_READY' });
  });

  videoIt('uses an immutable record snapshot and refuses unsafe or missing live occupancy', async () => {
    const id = await begin({ episodeIds: ['episode-one'] });
    loom.name = 'Changed after admission';
    const output = await archive(id);
    expect(JSON.parse(output.files.get('manifest.json')).loom.name).toBe('The quiet gate');
    delete loom.episodes[0].nodes[0].playbackAssets.audioOccupancy['hold-record'];
    const unsafe = await terminal(await begin({ episodeIds: ['episode-one'], allowDraft: true }));
    expect(unsafe).toMatchObject({ status: 'failed', error: { code: 'EXPORT_OCCUPANCY_UNSAFE' } });
  });

  it('refuses unsupported and malformed options before creating jobs', async () => {
    for (const input of [{ includePlayer: true },
      { mediaProfile: 'webm' }, { includeWebm: true }, { includeWebm: 'yes' }, { mediaProfile: { width: 100 } }, { allowDraft: 'yes' },
      { episodeIds: [] }, { episodeIds: ['episode-one', 'episode-one'] }, { destination: sourcePath }]) {
      const response = await request(app()).post('/api/fableloom/example-loom/export').send(input);
      expect(response.status, JSON.stringify(input)).toBe(400);
    }
    const voiceOnly = await request(app()).post('/api/fableloom/example-loom/export').send({ includeVoice: true });
    expect(voiceOnly.status).toBe(400);
    expect(voiceOnly.body.code).toBe('EXPORT_VOICE_REQUIRES_CHARACTERS');
    expect(listVoiceProfiles).not.toHaveBeenCalled();
    await expect(startFableLoomExport(loom.id, { episodeIds: ['unknown-episode'] })).rejects.toMatchObject({ code: 'EXPORT_EPISODES_INVALID' });
  });

  it('limits the cast to the protagonist and reachable staged characters', () => {
    const episodes = [{
      startNodeId: 'a',
      nodes: [
        { id: 'a', visualCanon: { characterAppearances: [{ characterId: 'hero' }, { characterId: 'on-stage' }] },
          interactionWindow: { protagonistCharacterId: 'speaker' },
          transitions: [{ targetNodeId: 'b' }] },
        { id: 'b', transitions: [] },
        { id: 'orphan', visualCanon: { characterAppearances: [{ characterId: 'secret-extra' }] }, transitions: [] },
      ],
    }];
    const loomCast = { protagonistCharacterId: 'hero', format: 'prose' };
    const universe = { characters: [
      { id: 'hero', name: 'Ada Example', personality: 'Calm.', background: privateMarker,
        secrets: 'SECRET_TOKEN_SENTINEL', voiceId: 'kokoro:SECRET_PRESET',
        adapters: [sourcePath], sessions: ['SESSION_TRANSCRIPT_SENTINEL'],
        voiceCanon: { version: 2, approved: true, sourcePolicy: 'designed', description: 'Warm.',
          defaultDelivery: 'Measured.', emotionalRange: ['steady'], avoid: ['never shout'],
          pronunciations: [{ term: 'Fable', pronunciation: 'FAY-bul', recordingPath: sourcePath }],
          recordingPath: sourcePath } },
      { id: 'on-stage', name: 'Draft', voiceCanon: { approved: false, description: 'rough' } },
      { id: 'speaker', name: 'Speaker' },
      { id: 'secret-extra', name: 'SECRET_CAST_SENTINEL', personality: privateMarker },
    ]};
    const blocked = inspectFableLoomExportCharacters(loomCast, episodes, universe);
    expect(blocked.characters.map(character => character.id)).toEqual(['hero', 'on-stage', 'speaker']);
    expect(blocked.findings.map(finding => finding.characterId)).toEqual(['on-stage', 'speaker']);
    expect(blocked.findings.every(finding => finding.severity === 'error' && finding.code === 'EXPORT_CHARACTER_DRAFT')).toBe(true);
    const hero = blocked.characters.find(character => character.id === 'hero');
    expect(hero.approval).toEqual({ voiceCanonVersion: 2, approved: true, sourcePolicy: 'designed', draftFlags: [] });
    expect(hero.pronunciations).toEqual([{ term: 'Fable', pronunciation: 'FAY-bul' }]);
    expect(hero.playTurn).toMatchObject({ promptId: 'fableloom-play-turn', contractVersion: '1.0.0' });
    expect(hero.role).toBe('protagonist');
    const drafted = inspectFableLoomExportCharacters(loomCast, episodes, universe, { allowDraft: true });
    expect(drafted.findings.every(finding => finding.severity === 'warning')).toBe(true);
    expect(drafted.characters.find(character => character.id === 'on-stage').approval.draftFlags).toEqual(['unapproved']);
    expect(drafted.characters.find(character => character.id === 'speaker').approval.draftFlags).toEqual(['unknown']);
    const packed = JSON.stringify(drafted.characters);
    for (const marker of [privateMarker, sourcePath, 'SECRET_TOKEN_SENTINEL', 'SESSION_TRANSCRIPT_SENTINEL', 'SECRET_CAST_SENTINEL', 'kokoro:', 'recordingPath']) {
      expect(packed.includes(marker), marker).toBe(false);
    }
  });

  it('fails closed when character approval, membership or identifiers are not portable', async () => {
    const unapproved = await terminal(await begin({ episodeIds: ['episode-one'], includeCharacters: true }));
    expect(unapproved).toMatchObject({ status: 'failed', error: { code: 'EXPORT_VALIDATION_FAILED' } });
    expect(unapproved.findings).toContainEqual(expect.objectContaining({
      code: 'EXPORT_CHARACTER_DRAFT', severity: 'error', characterId: 'example-character',
    }));
    expect(listVoiceProfiles).not.toHaveBeenCalled();
    getUniverse.mockResolvedValue({ characters: [] });
    const missing = await terminal(await begin({ episodeIds: ['episode-one'], includeCharacters: true }));
    expect(missing.findings).toContainEqual(expect.objectContaining({ code: 'EXPORT_CHARACTER_MISSING', severity: 'error' }));
    loom.episodes = [episode('episode-one')];
    loom.episodes[0].nodes[0].interactionWindow.protagonistCharacterId = 'not/portable';
    const badId = await terminal(await begin({ episodeIds: ['episode-one'], includeCharacters: true }));
    const idFinding = badId.findings.find(finding => finding.code === 'EXPORT_CHARACTER_ID');
    expect(idFinding).toMatchObject({ severity: 'error', message: 'Character identifiers must be portable identifiers.' });
    expect(idFinding).not.toHaveProperty('characterId');
    expect(badId).not.toHaveProperty('downloadUrl');
    await expect(stat(join(PATHS.data, 'cache/fableloom-exports', jobIds.at(-1), 'package.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
    loom.episodes = [episode('episode-one')];
    loom.episodes[0].nodes[0].interactionWindow.protagonistCharacterId = '';
    const empty = await terminal(await begin({ episodeIds: ['episode-one'], includeCharacters: true }));
    expect(empty.findings).toContainEqual(expect.objectContaining({ code: 'EXPORT_CAST_MISSING', severity: 'error' }));
    await expect(getFableLoomExportDownload(loom.id, jobIds.at(-1))).rejects.toMatchObject({ code: 'EXPORT_NOT_READY' });
  });

  it('refuses unapproved, ambiguous, unconsented and unlabeled voice references even when drafts are allowed', async () => {
    useCast();
    const digest = 'ab'.repeat(32);
    await expectVoiceRefusal([], 'EXPORT_VOICE_UNAPPROVED', { includeCharacters: true, includeVoice: true, allowDraft: true });
    await expectVoiceRefusal([
      voiceProfile({ sha256: digest, id: 'example-voice' }),
      voiceProfile({ sha256: 'cd'.repeat(32), id: 'example-voice-two' }),
    ], 'EXPORT_VOICE_AMBIGUOUS');
    await expectVoiceRefusal([voiceProfile({
      sha256: digest, kind: 'cloned',
      sourceAssets: [{ filename: 'reference.wav', sha256: digest, performerConsentConfirmed: false,
        licensePosture: 'generated-original-voice', transcript: 'SESSION_TRANSCRIPT_SENTINEL', path: sourcePath }],
    })], 'EXPORT_VOICE_CONSENT_MISSING');
    await expectVoiceRefusal([voiceProfile({
      sha256: digest,
      sourceAssets: [{ filename: 'notes.txt', sha256: digest, transcript: 'SESSION_TRANSCRIPT_SENTINEL' }],
    })], 'EXPORT_VOICE_REFERENCE_MISSING');
    const invalidProfile = await expectVoiceRefusal([voiceProfile({
      sha256: digest, id: 'Not A Profile',
    })], 'EXPORT_VOICE_REFERENCE_INVALID');
    expect(JSON.stringify(invalidProfile)).not.toContain('Not A Profile');
    const wrongUniverse = voiceProfile({ sha256: digest });
    wrongUniverse.binding.universeId = 'other-universe';
    await expectVoiceRefusal([wrongUniverse], 'EXPORT_VOICE_UNAPPROVED');
  });

  it('keeps a voice-reference hash mismatch and an escaping symlink out of the package', async () => {
    useCast();
    const bytes = Buffer.from('approved-reference-audio');
    const recorded = await writeVoiceReference(bytes);
    await expectVoiceRefusal([voiceProfile({ sha256: 'aa'.repeat(32) })], 'EXPORT_VOICE_REFERENCE_MISMATCH');
    expect(JSON.stringify(await getFableLoomExport(loom.id, jobIds.at(-1)))).not.toContain(recorded);
    await rm(PATHS.voiceProfiles, { recursive: true, force: true });
    const outsideDir = join(PATHS.data, 'outside-voice');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, 'reference.wav'), bytes);
    await mkdir(join(PATHS.voiceProfiles, 'example-voice'), { recursive: true });
    await symlink(outsideDir, join(PATHS.voiceProfiles, 'example-voice', 'source'));
    const escaped = await expectVoiceRefusal([voiceProfile({ sha256: hash(bytes) })], 'EXPORT_VOICE_REFERENCE_INVALID');
    expect(JSON.stringify(escaped)).not.toContain('outside-voice');
    expect(JSON.stringify(escaped)).not.toContain('reference.wav');
  });

  videoIt('exports approved character inputs without voice bytes', async () => {
    useCast();
    const packed = await archive(await begin({ episodeIds: ['episode-one'], includeCharacters: true }));
    const character = JSON.parse(packed.files.get('characters/example-character.json'));
    expect(character).toMatchObject({
      schemaVersion: '1.0.0', id: 'example-character', name: 'Ada Example', role: 'protagonist',
      persona: { personality: 'Calm and precise.', speechAccent: 'Neutral example accent.',
        speechPattern: 'Short sentences.', mannerisms: 'Pauses before answers.' },
      speech: { description: 'Warm mid register.', defaultDelivery: 'Measured.', emotionalRange: ['steady'] },
      pronunciations: [{ term: 'Fable', pronunciation: 'FAY-bul' }],
      safety: { neverSay: ['never shout'] },
      playTurn: { promptId: 'fableloom-play-turn', contractVersion: '1.0.0', inputs: { characterId: 'example-character', role: 'protagonist' } },
      approval: { voiceCanonVersion: 2, approved: true, sourcePolicy: 'designed', draftFlags: [] },
    });
    expect(Object.keys(character.pronunciations[0]).sort()).toEqual(['pronunciation', 'term']);
    const manifest = JSON.parse(packed.files.get('manifest.json'));
    expect(manifest.characters).toEqual([{ id: 'example-character', role: 'protagonist', file: 'characters/example-character.json' }]);
    const provenance = JSON.parse(packed.files.get('provenance.json'));
    expect(provenance.characters).toEqual([{
      id: 'example-character', file: 'characters/example-character.json',
      approved: true, draftFlags: [], voiceCanonVersion: 2,
    }]);
    expect(provenance.voices).toBeUndefined();
    expect([...packed.files.keys()].filter(name => name.startsWith('media/'))).toHaveLength(2);
    expect([...packed.files.keys()].some(name => name.endsWith('.wav'))).toBe(false);
    const readme = packed.files.get('README.md').toString();
    expect(readme).toContain('characters/<id>.json');
    expect(readme).toContain('Voice reference audio was not included');
    expect(readme).toContain('does not grant PortOS access');
    expect(readme).toContain('Your host owns free-text');
    assertPackageClean(packed);
    expect(listVoiceProfiles).not.toHaveBeenCalled();
  });

  videoIt('exports approved voice references with provenance and stable hashes', async () => {
    useCast();
    const bytes = Buffer.from('approved-reference-audio');
    const digest = await writeVoiceReference(bytes);
    listVoiceProfiles.mockResolvedValue([voiceProfile({ sha256: digest })]);
    const options = { episodeIds: ['episode-one'], includeCharacters: true, includeVoice: true };
    const first = await archive(await begin(options));
    const second = await archive(await begin(options));
    expect(second.bytes.equals(first.bytes)).toBe(true);
    const provenance = JSON.parse(first.files.get('provenance.json'));
    expect(provenance.voices).toEqual([{
      characterId: 'example-character', file: `media/${digest}.wav`, sha256: digest, bytes: bytes.length,
      approved: true, draftFlags: [], consentConfirmed: false,
      licensePosture: 'generated-original-voice', sourcePolicy: 'designed',
    }]);
    expect(first.files.get(`media/${digest}.wav`).equals(bytes)).toBe(true);
    expect(hash(first.files.get(`media/${digest}.wav`))).toBe(digest);
    const readme = first.files.get('README.md').toString();
    expect(readme).toContain('your own TTS');
    expect(readme).toContain('does not grant PortOS access');
    expect(readme).toContain('no PortOS URL, credential, or callback');
    assertPackageClean(first);
    useCast([approvedCharacter({ voiceCanon: { approved: false, description: 'rough' } })]);
    const drafted = await archive(await begin({ episodeIds: ['episode-one'], includeCharacters: true, allowDraft: true }));
    const draftCharacter = JSON.parse(drafted.files.get('characters/example-character.json'));
    expect(draftCharacter.approval).toMatchObject({ approved: false, draftFlags: ['unapproved'] });
    expect(JSON.parse(drafted.files.get('provenance.json')).voices).toBeUndefined();
    expect([...drafted.files.keys()].some(name => name.endsWith('.wav'))).toBe(false);
    assertPackageClean(drafted);
    listVoiceProfiles.mockResolvedValue([]);
    const voiceDraft = await terminal(await begin({
      episodeIds: ['episode-one'], includeCharacters: true, includeVoice: true, allowDraft: true,
    }));
    expect(voiceDraft).toMatchObject({ status: 'failed', error: { code: 'EXPORT_VALIDATION_FAILED' } });
    expect(voiceDraft.findings).toContainEqual(expect.objectContaining({ code: 'EXPORT_VOICE_UNAPPROVED', severity: 'error' }));
    expect(voiceDraft.findings).toContainEqual(expect.objectContaining({ code: 'EXPORT_CHARACTER_DRAFT', severity: 'warning' }));
  });

  it('never follows a remote, traversing or escaping symlink source and keeps failures path-free', async () => {
    for (const bad of ['https://example.com/movie.mp4', '../private.mp4', sourcePath + '.mp4']) {
      loadHistory.mockResolvedValue([{ id: 'entry-record', filename: bad }]);
      const result = await terminal(await begin({ episodeIds: ['episode-one'] }));
      expect(result).toMatchObject({ status: 'failed', error: { code: 'EXPORT_MEDIA_PATH' } });
      expect(JSON.stringify(result)).not.toContain(bad);
    }
    const outside = join(PATHS.data, 'outside.png');
    await writeFile(outside, sourceImage);
    await symlink(outside, join(PATHS.images, 'escape.png'));
    loom.episodes[0].nodes[0].image = 'escape.png';
    const result = await terminal(await begin({ episodeIds: ['episode-one'], allowDraft: true }));
    expect(result).toMatchObject({ status: 'failed', error: { code: 'EXPORT_MEDIA_PATH' } });
    await rm(join(PATHS.images, 'escape.png'));
  });

  it('persists actionable interruption and expiry states without treating malformed state as missing', async () => {
    loom.episodes[0].nodes[0].image = null;
    const id = await begin();
    await terminal(id);
    await __testing.drain();
    const stored = JSON.parse(await readFile(recordFile(id), 'utf8'));
    stored.status = 'packing';
    await writeFile(recordFile(id), JSON.stringify(stored));
    await expect(getFableLoomExport('another-loom', id)).rejects.toMatchObject({ status: 404 });
    expect(JSON.parse(await readFile(recordFile(id), 'utf8')).status).toBe('packing');
    expect(await getFableLoomExport(loom.id, id)).toMatchObject({ status: 'failed', error: { code: 'EXPORT_INTERRUPTED' } });
    stored.status = 'failed';
    stored.createdAt = Date.now() - FABLELOOM_EXPORT_LIMITS.maxAgeMs - 1;
    await writeFile(recordFile(id), JSON.stringify(stored));
    await expect(getFableLoomExport(loom.id, id)).rejects.toMatchObject({ code: 'EXPORT_EXPIRED', status: 410 });
    await begin();
    await expect(stat(recordFile(id))).rejects.toMatchObject({ code: 'ENOENT' });
    const last = jobIds.at(-1);
    await terminal(last);
    const valid = JSON.parse(await readFile(recordFile(last), 'utf8'));
    for (const invalid of ['{invalid-json', 'null', '{}', JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, status: 'completed', sizeReport: undefined })]) {
      await writeFile(recordFile(last), invalid);
      await expect(getFableLoomExport(loom.id, last)).rejects.toMatchObject({ code: 'EXPORT_STATE_INVALID', status: 503 });
    }
    await expect(getFableLoomExport(loom.id, '../../secret')).rejects.toMatchObject({ status: 404 });
  });

  videoIt('bounds the live queue and retains a leased download through terminal-job eviction', async () => {
    const prepare = media.prepareFableLoomExportMedia;
    const gate = Promise.withResolvers();
    vi.spyOn(media, 'prepareFableLoomExportMedia').mockImplementation(async (...args) => {
      await gate.promise;
      return prepare(...args);
    });
    const ids = [];
    try {
      ids.push(...await Promise.all(Array.from({ length: 4 }, () => begin({ episodeIds: ['episode-one'] }))));
      await expect(begin()).rejects.toMatchObject({ code: 'EXPORT_QUEUE_FULL', status: 429 });
    } finally { gate.resolve(); await __testing.drain(); }
    for (const [index, id] of ids.entries()) {
      expect(await getFableLoomExport(loom.id, id)).toMatchObject({ status: 'completed' });
      const stored = JSON.parse(await readFile(recordFile(id), 'utf8'));
      stored.createdAt = Date.now() - (ids.length - index) * 1000;
      await writeFile(recordFile(id), JSON.stringify(stored));
    }
    const lease = await getFableLoomExportDownload(loom.id, ids[0]);
    try {
      loom.episodes[0].nodes[0].image = null;
      await terminal(await begin());
      expect((await readFile(lease.path)).subarray(0, 2).toString()).toBe('PK');
      await expect(getFableLoomExport(loom.id, ids[1])).rejects.toMatchObject({ status: 404 });
    } finally { lease.release(); lease.release(); }
    await terminal(await begin());
    await expect(getFableLoomExport(loom.id, ids[0])).rejects.toMatchObject({ status: 404 });
  });

  it('rejects an oversized source before decoding or allocating its bytes', async () => {
    const filename = join(PATHS.images, 'oversized.png');
    await writeFile(filename, '');
    await truncate(filename, FABLELOOM_EXPORT_LIMITS.maxAssetBytes + 1);
    loom.episodes[0].nodes[0].image = 'oversized.png';
    const result = await terminal(await begin({ episodeIds: ['episode-one'] }));
    expect(result).toMatchObject({ status: 'failed', error: { code: 'EXPORT_MEDIA_SIZE' } });
    await rm(filename);
  });

  it('retains one bounded buffer for identical sources and gives ID caches only small descriptors', () => {
    const store = __testing.createMediaStore(4);
    const original = Buffer.from('abc');
    const descriptors = Array.from({ length: 50 }, (_, index) => store.add({
      bytes: index ? Buffer.from('abc') : original, extension: 'mp4', durationMs: 1000,
    }));
    expect(store.byteLength).toBe(3);
    expect(store.size).toBe(1);
    expect([...store.entries()][0][1]).toBe(original);
    expect(descriptors.every(d => !Object.values(d).some(Buffer.isBuffer))).toBe(true);
    expect(() => store.add({ bytes: Buffer.from('de'), extension: 'mp4', durationMs: 1000 }))
      .toThrow(expect.objectContaining({ code: 'EXPORT_PACKAGE_SIZE' }));
    expect(store.byteLength).toBe(3);
  });

  posixIt('rejects a named pipe without a writer and lets the next queued export progress', async ({ signal }) => {
    const pipe = join(PATHS.images, 'pipe.png');
    execFileSync('mkfifo', [pipe], { timeout: 5000 });
    const releaseBlockedReader = () => {
      try { closeSync(openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK)); }
      catch (failure) { if (!['ENXIO', 'ENOENT'].includes(failure.code)) throw failure; }
    };
    signal.addEventListener('abort', releaseBlockedReader, { once: true });
    try {
      loom.episodes[0].nodes[0].image = 'pipe.png';
      const result = await terminal(await begin({ episodeIds: ['episode-one'] }));
      expect(result).toMatchObject({ status: 'failed', error: { code: 'EXPORT_MEDIA_SIZE' } });
      loom.episodes[0].nodes[0].image = null;
      const next = await terminal(await begin({ episodeIds: ['episode-one'] }));
      expect(next).toMatchObject({ status: 'failed', error: { code: 'EXPORT_VALIDATION_FAILED' } });
    } finally {
      releaseBlockedReader();
      signal.removeEventListener('abort', releaseBlockedReader);
      await __testing.drain();
      await rm(pipe);
    }
  });
});
