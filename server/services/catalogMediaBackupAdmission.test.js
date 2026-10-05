/**
 * Catalog media, voice-memo scraps and imported round reference audio against a
 * backup cut (#9982). Each writes its file first and then commits the row that
 * first names it. A cut copies files before it dumps rows, so the row commit
 * takes the lease: a row held behind a cut can only name bytes the copy took,
 * and the file write and slow work (transcription, extraction, download) stay
 * outside it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/databaseMaintenanceJournal.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertDatabaseAdmission: () => {},
}));
vi.mock('./catalogDB.js', () => ({ getIngredient: vi.fn(), attachMedia: vi.fn(), createChunkedScrap: vi.fn() }));
vi.mock('./catalogExtraction.js', () => ({ extractIngredientsForScrap: vi.fn() }));
vi.mock('./voice/stt.js', () => ({ transcribe: vi.fn() }));
vi.mock('./browserService.js', () => ({ navigateToUrlPinned: vi.fn() }));
vi.mock('./rounds.js', () => ({ attachReferenceAudio: vi.fn() }));
vi.mock('../lib/safeUrlFetch.js', () => ({ assertPublicHttpUrl: vi.fn(async () => {}) }));
vi.mock('../lib/sseUtils.js', () => ({ broadcastSse: vi.fn(), attachSseClient: vi.fn(), closeJobAfterDelay: vi.fn() }));
vi.mock('./ytdlpAudioImport.js', () => ({
  resolveYtDlpBinaries: vi.fn(async () => ({ ytDlp: '/mock/yt-dlp', ffmpeg: '/mock/ffmpeg' })),
  downloadAudioToTempMp3: vi.fn(async () => ({ outcome: 'ok', title: 'Example Clip', outPath: '/mock/tmp/clip.mp3' })),
  cleanupYtDlpTemp: vi.fn(async () => {}),
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  importFileToUploads: vi.fn(async () => ({ filename: 'ab12cd34-Example_Clip.mp3' })),
}));

const catalogDB = await import('./catalogDB.js');
const { extractIngredientsForScrap } = await import('./catalogExtraction.js');
const { attachReferenceAudio } = await import('./rounds.js');
const { importFileToUploads } = await import('../lib/fileUtils.js');
const { uploadIngredientMediaFile, recordIngredientVoiceMemo } = await import('./catalogMedia.js');
const { ingestFromVoice } = await import('./catalogIngestSources.js');
const { startReferenceAudioImport } = await import('./roundReferenceAudioImport.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const AUDIO = Buffer.from('example-audio-bytes').toString('base64');

/**
 * Start a workflow while a cut is held, assert what it may already have done
 * (`whileHeld`), then release the cut and resolve with the workflow result.
 */
async function runAcrossCut(start, whileHeld) {
  const release = await acquireBackupSnapshotCut();
  let pending;
  try {
    pending = start();
    await settle();
    whileHeld();
  } finally {
    release();
  }
  return pending;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  catalogDB.getIngredient.mockResolvedValue({ id: 'ing-example' });
  catalogDB.attachMedia.mockImplementation(async (_id, mediaKey) => ({ mediaKey }));
  catalogDB.createChunkedScrap.mockResolvedValue({ id: 'scrap-example' });
  extractIngredientsForScrap.mockResolvedValue({ ingredients: [] });
  attachReferenceAudio.mockResolvedValue(true);
});

describe('catalog media rows and a backup cut', () => {
  const persistFileFn = vi.fn(async () => 'upload-example.webm');

  it.each([
    ['an uploaded file', () => uploadIngredientMediaFile(
      { ingredientId: 'ing-example', dataBase64: AUDIO, mimeType: 'audio/webm' },
      { persistFileFn },
    )],
    ['a recorded voice memo', () => recordIngredientVoiceMemo(
      { ingredientId: 'ing-example', audioBase64: AUDIO, mimeType: 'audio/webm' },
      { persistFileFn, transcribeFn: async () => ({ text: 'example memo' }) },
    )],
  ])('holds the media row for %s until the cut releases', async (_name, start) => {
    await runAcrossCut(start, () => {
      expect(persistFileFn).toHaveBeenCalled();
      expect(catalogDB.attachMedia).not.toHaveBeenCalled();
    });
    expect(catalogDB.attachMedia).toHaveBeenCalledWith('ing-example', 'upload-example.webm', 'audio', expect.any(Object));
  });

  it('holds a voice-memo scrap naming its audio, and extracts only after it commits', async () => {
    const persistFn = vi.fn(async () => 'voice-memo-example.wav');
    const result = await runAcrossCut(
      () => ingestFromVoice({ audioBase64: AUDIO }, { persistFn, transcribeFn: async () => ({ text: 'example memo' }) }),
      () => {
        expect(persistFn).toHaveBeenCalled();
        expect(catalogDB.createChunkedScrap).not.toHaveBeenCalled();
      },
    );
    expect(result).toMatchObject({ mediaKey: 'voice-memo-example.wav' });
    expect(catalogDB.createChunkedScrap).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ mediaKey: 'voice-memo-example.wav' }),
    }));
    expect(extractIngredientsForScrap).toHaveBeenCalledWith(expect.objectContaining({ scrapId: 'scrap-example' }));
  });
});

describe('imported round reference audio and a backup cut', () => {
  it('lands the file but holds the reference row that names it until the cut releases', async () => {
    let finished;
    const done = new Promise((resolve) => { finished = resolve; });
    attachReferenceAudio.mockImplementation(async () => { finished(); return true; });

    await runAcrossCut(
      () => startReferenceAudioImport('https://example.com/clip', { roundId: 'round-example', referenceId: 'ref-example' }),
      () => {
        expect(importFileToUploads).toHaveBeenCalled();
        expect(attachReferenceAudio).not.toHaveBeenCalled();
      },
    );
    await done;
    expect(attachReferenceAudio).toHaveBeenCalledWith('round-example', 'ref-example', 'ab12cd34-Example_Clip.mp3');
  });
});
