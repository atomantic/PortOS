/** Pipeline audio line PATCH and cue render must refuse a stale target with a
 * real status instead of returning a 200 that silently discarded the edit. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

let audioStage;
const generateMusic = vi.fn();
const synthesizeToFile = vi.fn();
const noopFn = () => vi.fn();

vi.mock('../../services/pipeline/series.js', () => ({ getSeries: async () => ({ id: 'series-1', universeId: null }) }));
vi.mock('../../services/pipeline/seriesCanon.js', () => ({ getSeriesCanon: async () => ({}) }));
vi.mock('../../services/pipeline/issues.js', () => ({
  getIssue: async () => ({ id: 'issue-1', seriesId: 'series-1', stages: { audio: structuredClone(audioStage) } }),
  assertStageUnlocked: () => {},
  // Mirrors the real contract: the callback sees the freshest stage and `{}` is a no-op.
  updateStageWithLatest: async (_id, _name, fn) => {
    const patch = fn(structuredClone(audioStage));
    audioStage = { ...audioStage, ...patch };
    return { issue: { id: 'issue-1' }, stage: audioStage };
  },
  updateStage: async () => ({ issue: { id: 'issue-1' }, stage: audioStage }),
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
  clearVoiceProfileRender: async () => {},
  recordVoiceProfileRender: async () => {},
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


const { default: router } = await import('./audio.js');

const app = express();
app.use(express.json());
app.use(router);
app.use(errorMiddleware);

beforeEach(() => {
  audioStage = { cues: [{ prompt: 'a calm bed' }], lines: [{ id: 'line-1', text: 'Hello there.' }] };
  generateMusic.mockReset().mockResolvedValue({
    filename: 'music-gen-1.wav', durationSec: 10, modelId: 'example-model', model: 'Example model', engine: 'example-engine',
  });
});

describe('PATCH audio line', () => {
  it('edits an existing line', async () => {
    const res = await request(app).patch('/issues/issue-1/stages/audio/lines/0').send({ text: 'Changed.' });
    expect(res.status).toBe(200);
    expect(res.body.stage.lines[0].text).toBe('Changed.');
  });

  it('returns 404 when the line index is out of range', async () => {
    const res = await request(app).patch('/issues/issue-1/stages/audio/lines/5').send({ text: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PIPELINE_AUDIO_LINE_NOT_FOUND');
  });
});

describe('POST audio cue render', () => {
  it('persists the rendered track on an existing cue', async () => {
    const res = await request(app).post('/issues/issue-1/stages/audio/cues/0/render').send({});
    expect(res.status).toBe(200);
    expect(res.body.cue.trackFilename).toBe('music-gen-1.wav');
  });

  it('returns 409 when the cue vanished while rendering', async () => {
    generateMusic.mockImplementation(async () => {
      audioStage = { ...audioStage, cues: [] };
      return { filename: 'music-gen-1.wav', durationSec: 10, modelId: 'example-model', engine: 'example-engine' };
    });
    const res = await request(app).post('/issues/issue-1/stages/audio/cues/0/render').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PIPELINE_AUDIO_CUE_STALE_TARGET');
  });
});
