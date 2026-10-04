/** Pipeline audio routes that name a freshly written audio file in an issue row.
 * The WAV exists before the row does, so the row commit is the publication: a
 * backup cut must never dump a row naming audio its file copy had not reached
 * (#9982). Each row write is held at its commit seam. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

let beforeRowWrite = async () => {};
let rowWrites = [];
const rowWrite = async (label, result) => {
  await beforeRowWrite();
  rowWrites.push(label);
  return result;
};
const generateMusic = vi.fn();
const synthesizeToFile = vi.fn();
const noopFn = () => vi.fn();

vi.mock('../../services/pipeline/series.js', () => ({ getSeries: async () => ({ id: 'series-1', universeId: null }) }));
vi.mock('../../services/pipeline/seriesCanon.js', () => ({ getSeriesCanon: async () => ({}) }));
vi.mock('../../services/pipeline/issues.js', () => ({
  getIssue: async () => ({
    id: 'issue-1',
    seriesId: 'series-1',
    stages: { audio: { cues: [{ prompt: 'a calm bed' }], lines: [{ id: 'line-1', text: 'Hello there.' }] } },
  }),
  assertStageUnlocked: () => {},
  updateStageWithLatest: async () => rowWrite('stage', {
    issue: { id: 'issue-1' },
    stage: { music: { trackFilename: 'music-gen-1.wav' }, cues: [{ trackFilename: 'music-gen-1.wav' }] },
  }),
  updateStage: async () => rowWrite('stage', { issue: { id: 'issue-1' }, stage: { lines: [] } }),
}));
vi.mock('../../services/pipeline/audio.js', () => ({
  listAllVoices: noopFn(),
  parseVoiceId: noopFn(),
  extractDialogueLines: noopFn(),
  resolveVoiceForLine: () => null,
  synthesizeToFile: (...args) => synthesizeToFile(...args),
}));
vi.mock('../../services/pipeline/manuscriptNarration.js', () => ({ narrateProse: noopFn() }));
vi.mock('../../services/voice/tts.js', () => ({ synthesize: noopFn() }));
vi.mock('../../services/voice/profiles.js', () => ({
  resolveCharacterVoice: noopFn(),
  clearVoiceProfileRender: async () => rowWrite('render-cleared'),
  recordVoiceProfileRender: async () => rowWrite('render-recorded'),
}));
vi.mock('../../services/pipeline/musicLibrary.js', () => ({
  MUSIC_SOURCE: { UPLOAD: 'upload', LIBRARY: 'library', GEN: 'gen' },
  MUSIC_UPLOAD_MAX_BYTES: 1024,
  isSupportedMusicUpload: () => true,
  listMusicLibrary: noopFn(),
  importUploadedTrack: noopFn(),
  deleteMusicTrack: noopFn(),
  statMusicTrack: noopFn(),
}));
vi.mock('../../services/pipeline/musicGen.js', () => ({
  DEFAULT_ENGINE_ID: 'example-engine',
  ENGINES: {
    'example-engine': {
      id: 'example-engine', name: 'Example', models: [{ id: 'example-model', name: 'Example model' }],
      defaultModelId: 'example-model', defaultDurationSec: 10, minDurationSec: 1, maxDurationSec: 60, installEnv: 'EXAMPLE',
    },
  },
  isEngineHealthy: async () => true,
  generateMusic: (...args) => generateMusic(...args),
}));
vi.mock('../../services/pipeline/audioCues.js', () => ({ deriveAudioCues: noopFn(), preserveRenderedCues: noopFn() }));
vi.mock('./shared.js', () => ({ mapServiceError: error => error }));

const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const { default: router } = await import('./audio.js');

const app = express();
app.use(express.json());
app.use(router);
app.use(errorMiddleware);

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const settleSeveral = async () => { for (let i = 0; i < 8; i += 1) await settle(); };
const holdRowWrite = () => {
  const reached = deferred();
  const commit = deferred();
  beforeRowWrite = async () => { reached.resolve(); await commit.promise; };
  return { reached: reached.promise, commit: commit.resolve };
};
const post = (url, body = {}) => request(app).post(url).send(body).then(response => response);

const ROUTES = [
  { name: 'music generation', url: '/issues/issue-1/stages/audio/music/generate', body: { prompt: 'a calm bed' }, bytes: generateMusic },
  { name: 'cue render', url: '/issues/issue-1/stages/audio/cues/0/render', body: {}, bytes: generateMusic },
  { name: 'voice-over line render', url: '/issues/issue-1/stages/audio/lines/0/render', body: {}, bytes: synthesizeToFile },
];

beforeEach(() => {
  beforeRowWrite = async () => {};
  rowWrites = [];
  generateMusic.mockReset().mockResolvedValue({
    filename: 'music-gen-1.wav', durationSec: 10, modelId: 'example-model', model: 'Example model', engine: 'example-engine',
  });
  synthesizeToFile.mockReset().mockResolvedValue({
    filename: 'vo-1.wav', latencyMs: 10, durationMs: 1000, engine: 'kokoro', voiceId: 'kokoro:example',
    provenance: { profileId: 'profile-1', profileRevision: 1, engine: 'kokoro' },
  });
});

describe.each(ROUTES)('$name', ({ url, body, bytes }) => {
  it('drains a row commit already in flight before the cut proceeds', async () => {
    const hold = holdRowWrite();
    const response = post(url, body);
    await hold.reached;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    await settleSeveral();
    expect(cutReady).toBe(false);
    hold.commit();
    expect((await response).status).toBe(200);
    const release = await cut;
    expect(rowWrites.length).toBeGreaterThan(0);
    release();
  });

  it('keeps producing the audio during a cut but commits no row until it ends', async () => {
    const release = await acquireBackupSnapshotCut();
    const response = post(url, body);
    await vi.waitFor(() => expect(bytes).toHaveBeenCalledTimes(1));
    await settleSeveral();
    expect(rowWrites).toEqual([]);
    release();
    expect((await response).status).toBe(200);
    expect(rowWrites.length).toBeGreaterThan(0);
  });
});
