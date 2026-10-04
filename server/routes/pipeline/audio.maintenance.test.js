import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

const fixture = vi.hoisted(() => ({ admission: null, issue: null, generate: vi.fn(), save: vi.fn() }));
vi.mock('../../lib/maintenanceAdmission.js', async importOriginal => ({
  ...await importOriginal(),
  maintenance: new Proxy({}, { get: (_target, property) => fixture.admission[property] }),
}));
vi.mock('../../services/pipeline/series.js', () => ({}));
vi.mock('../../services/pipeline/issues.js', () => ({
  getIssue: async () => fixture.issue,
  assertStageUnlocked: () => {},
  updateStageWithLatest: (...args) => fixture.save(...args),
}));
vi.mock('../../services/pipeline/seriesCanon.js', () => ({ getSeriesCanon: vi.fn() }));
vi.mock('../../lib/seriesLlmOverride.js', () => ({ resolveSeriesLlmOverride: vi.fn() }));
vi.mock('../../services/pipeline/audio.js', () => ({
  listAllVoices: vi.fn(), synthesizeToFile: vi.fn(), parseVoiceId: vi.fn(),
  extractDialogueLines: vi.fn(), resolveVoiceForLine: vi.fn(),
}));
vi.mock('../../services/pipeline/manuscriptNarration.js', () => ({ narrateProse: vi.fn() }));
vi.mock('../../services/voice/tts.js', () => ({ synthesize: vi.fn() }));
vi.mock('../../services/voice/profiles.js', () => ({
  clearVoiceProfileRender: vi.fn(), recordVoiceProfileRender: vi.fn(), resolveCharacterVoice: vi.fn(),
}));
vi.mock('../../services/pipeline/musicLibrary.js', () => ({
  listMusicLibrary: vi.fn(), importUploadedTrack: vi.fn(), deleteMusicTrack: vi.fn(),
  statMusicTrack: vi.fn(), isSupportedMusicUpload: vi.fn(), MUSIC_UPLOAD_MAX_BYTES: 1024,
  MUSIC_SOURCE: { NONE: 'none', UPLOAD: 'upload', GEN: 'gen' },
}));
vi.mock('../../services/pipeline/musicGen.js', () => ({
  generateMusic: (...args) => fixture.generate(...args),
  ENGINES: { musicgen: { models: [{ id: 'example-model' }], maxDurationSec: 30 } },
  DEFAULT_ENGINE_ID: 'musicgen', isEngineHealthy: async () => true,
}));
vi.mock('../../services/pipeline/audioCues.js', () => ({ deriveAudioCues: vi.fn(), preserveRenderedCues: vi.fn() }));
vi.mock('../../lib/multipart.js', () => ({ uploadSingle: () => (_req, _res, next) => next() }));
vi.mock('./shared.js', () => ({ mapServiceError: error => error }));

import router from './audio.js';
import { createMaintenanceAdmission } from '../../lib/maintenanceAdmission.js';
import { acquireBackupSnapshotCut } from '../../lib/backupSnapshotBoundary.js';

const generated = { filename: 'synthetic.wav', durationSec: 12, engine: 'musicgen', modelId: 'example-model', model: 'Example' };
const endpoint = kind => `/api/pipeline/issues/example/stages/audio/${kind === 'music' ? 'music/generate' : 'cues/0/render'}`;
let root;
let app;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pipeline-audio-maintenance-'));
  fixture.admission = createMaintenanceAdmission(root);
  fixture.issue = { id: 'example', stages: { audio: { cues: [{ prompt: 'Synthetic audio', engine: 'musicgen' }] } } };
  fixture.generate.mockReset().mockResolvedValue(generated);
  fixture.save.mockReset().mockImplementation(async (_id, _stage, update) => {
    const stage = { ...fixture.issue.stages.audio, ...update(fixture.issue.stages.audio) };
    fixture.issue.stages.audio = stage;
    return { issue: fixture.issue, stage };
  });
  app = express();
  app.use(express.json());
  app.use('/api/pipeline', router);
  app.use(errorMiddleware);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.each(['music', 'cue'])('direct pipeline %s rendering maintenance', kind => {
  const send = () => request(app).post(endpoint(kind)).send({ prompt: 'Synthetic audio' });

  it('rejects a manual render during Ready before generation or persistence', async () => {
    fixture.admission.begin({ reason: 'Hold new renders', owner: 'Operator' });
    expect(fixture.admission.status().state).toBe('ready');
    const response = await send();
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('MAINTENANCE_HELD');
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('keeps an admitted render owned through generation and the final stage save', async () => {
    const rendering = Promise.withResolvers();
    const saving = Promise.withResolvers();
    fixture.generate.mockReturnValue(rendering.promise);
    const save = fixture.save.getMockImplementation();
    fixture.save.mockImplementation(async (...args) => { await saving.promise; return save(...args); });
    const response = send().then(value => value);
    try {
      await vi.waitFor(() => expect(fixture.generate).toHaveBeenCalledTimes(1));
      fixture.admission.begin({ reason: 'Drain this render', owner: 'Operator' });
      expect(fixture.admission.status().state).toBe('draining');
      rendering.resolve(generated);
      await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledTimes(1));
      expect(fixture.admission.status().state).toBe('draining');
      saving.resolve();
      expect((await response).status).toBe(200);
      expect(fixture.admission.status().state).toBe('ready');
      const audio = fixture.issue.stages.audio;
      expect(kind === 'music' ? audio.music.trackFilename : audio.cues[0].trackFilename).toBe('synthetic.wav');
    } finally {
      rendering.resolve(generated);
      saving.resolve();
      await response;
    }
  });

  it('retains a recovery blocker when the rendered track cannot be saved to its stage', async () => {
    fixture.save.mockImplementation(async () => {
      fixture.admission.begin({ reason: 'Drain during save', owner: 'Operator' });
      throw new Error('Stage storage unavailable');
    });
    expect((await send()).status).toBe(500);
    expect(fixture.admission.status()).toMatchObject({
      state: 'draining', blockers: [expect.objectContaining({ kind: 'settlement', unsettled: true })],
    });
  });

  it('keeps maintenance draining while an admitted render waits for the backup cut and final row save', async () => {
    const rendering = Promise.withResolvers();
    const saving = Promise.withResolvers();
    fixture.generate.mockReturnValue(rendering.promise);
    const save = fixture.save.getMockImplementation();
    fixture.save.mockImplementation(async (...args) => { await saving.promise; return save(...args); });
    const response = send().then(value => value);
    let releaseCut;
    try {
      await vi.waitFor(() => expect(fixture.generate).toHaveBeenCalledTimes(1));
      releaseCut = await acquireBackupSnapshotCut();
      fixture.admission.begin({ reason: 'Drain during backup cut', owner: 'Operator' });
      rendering.resolve(generated);
      await vi.waitFor(() => expect(fixture.admission.status().blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'settlement' }),
      ])));
      expect(fixture.save).not.toHaveBeenCalled();
      expect(fixture.admission.status().state).toBe('draining');
      releaseCut();
      await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledTimes(1));
      expect(fixture.admission.status().state).toBe('draining');
      saving.resolve();
      expect((await response).status).toBe(200);
      expect(fixture.admission.status().state).toBe('ready');
      const audio = fixture.issue.stages.audio;
      expect(kind === 'music' ? audio.music.trackFilename : audio.cues[0].trackFilename).toBe('synthetic.wav');
    } finally {
      rendering.resolve(generated);
      releaseCut?.();
      saving.resolve();
      await response;
    }
  });
});
