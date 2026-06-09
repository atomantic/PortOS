/**
 * Pipeline audio routes — TTS voices/preview/synthesis, the audio stage's
 * per-line VO operations, the shared music library (upload / generate /
 * attach), and arc-driven audio cues.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import { getSeriesCanon } from '../../services/pipeline/seriesCanon.js';
import { resolveSeriesLlmOverride } from '../../lib/seriesLlmOverride.js';
import { listAllVoices, synthesizeToFile, parseVoiceId, extractDialogueLines, resolveVoiceForLine } from '../../services/pipeline/audio.js';
import { synthesize as synthesizeVoice } from '../../services/voice/tts.js';
import {
  listMusicLibrary,
  importUploadedTrack,
  deleteMusicTrack,
  statMusicTrack,
  isSupportedMusicUpload,
  MUSIC_SOURCE,
  MUSIC_UPLOAD_MAX_BYTES,
} from '../../services/pipeline/musicLibrary.js';
import {
  generateMusic,
  ENGINES,
  DEFAULT_ENGINE_ID,
  isEngineReady,
} from '../../services/pipeline/musicGen.js';
import { deriveAudioCues, preserveRenderedCues } from '../../services/pipeline/audioCues.js';
import { uploadSingle } from '../../lib/multipart.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Merged voice list across every supported TTS engine (Kokoro + Piper today;
// future ElevenLabs/etc. when added). Each voice is namespaced with
// `engine:voiceName` so the character voice picker shows a single flat list.
router.get('/tts/voices', asyncHandler(async (_req, res) => {
  res.json({ voices: await listAllVoices() });
}));

// Audition a voice before binding it to a character. Returns the rendered
// WAV inline so the picker can <audio> it without persisting anything. Body:
// { voiceId, text? } — text defaults to a short generic sample.
const ttsPreviewSchema = z.object({
  voiceId: z.string().trim().min(1).max(200),
  text: z.string().trim().max(500).optional(),
});
const DEFAULT_PREVIEW_TEXT = 'The morning fog burned off slow that day, and nothing felt quite the same after.';
router.post('/tts/preview', asyncHandler(async (req, res) => {
  const body = validateRequest(ttsPreviewSchema, req.body ?? {});
  const { engine, voice } = parseVoiceId(body.voiceId);
  const text = body.text || DEFAULT_PREVIEW_TEXT;
  // Surface "unknown voice" + transient model-load failures as 400/503 with
  // a useful message instead of asyncHandler's default 500.
  let wav; let latencyMs; let usedEngine;
  try {
    ({ wav, latencyMs, engine: usedEngine } = await synthesizeVoice(text, {
      ...(engine ? { engine } : {}),
      ...(voice ? { voice } : {}),
    }));
  } catch (err) {
    if (err?.message?.startsWith('unknown') || err?.code === 'UNKNOWN_VOICE') {
      throw new ServerError(err.message, { status: 400, code: 'PIPELINE_AUDIO_UNKNOWN_VOICE' });
    }
    throw err;
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('X-TTS-Latency-Ms', String(latencyMs));
  res.setHeader('X-TTS-Engine', usedEngine);
  res.send(wav);
}));

// Persist a one-off voice line to disk under PATHS.audio and return the
// resulting filename. The audio stage's lines[] table calls this to render
// individual dialogue lines; the bulk "render all dialogue" flow lands in
// a follow-up. Mainly intended for the per-line Render button in the UI.
const ttsSynthesizeSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  voiceId: z.string().trim().max(200).optional(),
});
router.post('/tts/synthesize', asyncHandler(async (req, res) => {
  const body = validateRequest(ttsSynthesizeSchema, req.body ?? {});
  const result = await synthesizeToFile({ text: body.text, voiceId: body.voiceId })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Walk the issue's storyboards.scenes[].dialogue and populate
// stages.audio.lines[]. `force: true` replaces existing lines wholesale;
// the default refuses overwrite when lines[] is already populated so a
// stray click can't wipe a user's manual edits.
const extractAudioLinesSchema = z.object({ force: z.boolean().optional() });
router.post('/issues/:id/stages/audio/extract-lines', asyncHandler(async (req, res) => {
  const body = validateRequest(extractAudioLinesSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'audio');
  const existingLines = issue.stages?.audio?.lines || [];
  if (existingLines.length > 0 && !body.force) {
    throw new ServerError(
      `Audio stage already has ${existingLines.length} line${existingLines.length === 1 ? '' : 's'}. Pass force: true to replace.`,
      { status: 409, code: 'PIPELINE_AUDIO_LINES_EXIST' },
    );
  }
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });
  // Carry forward already-rendered audio on re-extract when the same speaker
  // + same line text appears in the fresh extraction — otherwise a small edit
  // anywhere upstream would silently invalidate every previously-rendered WAV.
  // Phase B.4: canon lives on the linked universe — bind dialogue speakers
  // by name against `universe.characters` instead of the now-defunct
  // `series.characters`.
  const canon = await getSeriesCanon(series);
  const { lines, preservedCount } = extractDialogueLines(issue, { characters: canon.characters }, {
    preserveFrom: existingLines,
  });
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(req.params.id, 'audio', {
    status: lines.length ? 'ready' : 'empty',
    lines,
    errorMessage: '',
  });
  res.json({ issue: updatedIssue, stage, lineCount: lines.length, preservedCount });
}));

// Per-line edit endpoint. Replaces the prior whole-stage PATCH path so a
// blur-save against line N can't clobber a concurrent edit against line M
// — the server merges against the freshest persisted record inside the
// per-issue write queue. Patch fields are intentionally narrow (text +
// voiceIdOverride); the per-line audio fields are owned by the render path.
const lineEditSchema = z.object({
  text: z.string().max(4000).optional(),
  voiceIdOverride: z.string().trim().max(200).nullable().optional(),
  // Per-line VO start offset (seconds into the stitched episode). null clears
  // the placement so the muxer skips the line. The sanitizer clamps the range.
  offsetSec: z.number().min(0).max(7200).nullable().optional(),
});
router.patch('/issues/:id/stages/audio/lines/:lineIdx', asyncHandler(async (req, res) => {
  const lineIdx = Number(req.params.lineIdx);
  if (!Number.isInteger(lineIdx) || lineIdx < 0) {
    throw new ServerError('lineIdx must be a non-negative integer', {
      status: 400, code: 'PIPELINE_AUDIO_BAD_INDEX',
    });
  }
  const body = validateRequest(lineEditSchema, req.body ?? {});
  if (Object.keys(body).length === 0) {
    throw new ServerError('patch must include at least one field', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => {
      const lines = Array.isArray(current?.lines) ? current.lines : [];
      const line = lines[lineIdx];
      if (!line) return {};
      const next = { ...line };
      if ('text' in body) next.text = body.text;
      if ('voiceIdOverride' in body) next.voiceIdOverride = body.voiceIdOverride;
      if ('offsetSec' in body) next.offsetSec = body.offsetSec;
      const nextLines = [...lines];
      nextLines[lineIdx] = next;
      return { status: 'edited', lines: nextLines };
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage, lineIdx });
}));

// Render one VO line. Voice resolution priority:
//   1. body.voiceId           (per-request override)
//   2. line.voiceIdOverride   (per-line override saved on the issue)
//   3. character.voiceId      (linked-universe canon binding via getSeriesCanon)
//   4. (none → uses the configured default voice via synthesize())
const lineRenderSchema = z.object({ voiceId: z.string().trim().max(200).optional() });
router.post('/issues/:id/stages/audio/lines/:lineIdx/render', asyncHandler(async (req, res) => {
  const lineIdx = Number(req.params.lineIdx);
  if (!Number.isInteger(lineIdx) || lineIdx < 0) {
    throw new ServerError('lineIdx must be a non-negative integer', {
      status: 400, code: 'PIPELINE_AUDIO_BAD_INDEX',
    });
  }
  const body = validateRequest(lineRenderSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'audio');
  const lines = issue.stages?.audio?.lines || [];
  const line = lines[lineIdx];
  if (!line) {
    throw new ServerError(`lineIdx ${lineIdx} out of range (have ${lines.length})`, {
      status: 404, code: 'PIPELINE_AUDIO_LINE_NOT_FOUND',
    });
  }
  // Resolve voice via the shared priority chain (explicit > line override
  // > character binding > project default). One source of truth, reused by
  // the eventual "render all" flow + unit-tested for priority order. Skip
  // the canon load when a higher-priority resolver will win — otherwise
  // every per-line render pays two file reads it doesn't use.
  const needsCanon = !body.voiceId?.trim() && !line.voiceIdOverride && line.characterId;
  let canon = null;
  if (needsCanon) {
    const series = await seriesSvc.getSeries(issue.seriesId).catch(() => null);
    if (series) canon = await getSeriesCanon(series);
  }
  const voiceId = resolveVoiceForLine(line, canon, { explicit: body.voiceId });
  const synthResult = await synthesizeToFile({ text: line.text, voiceId })
    .catch((err) => { throw mapServiceError(err); });
  const nextLines = [...lines];
  nextLines[lineIdx] = {
    ...line,
    audioJobId: null,
    audioFilename: synthResult.filename,
  };
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(req.params.id, 'audio', {
    status: 'edited',
    lines: nextLines,
    errorMessage: '',
  });
  res.json({
    issue: updatedIssue, stage, lineIdx,
    filename: synthResult.filename,
    engine: synthResult.engine,
    voiceId: synthResult.voiceId || voiceId,
  });
}));

// Music library — shared across every issue; the audio stage stores only a
// pointer (`music.trackFilename`). Local OSS generation (4c.2) and 3rd-party
// engines (4c.3) plug in as sibling sources behind the same library list.

const musicUpload = uploadSingle('track', {
  limits: { fileSize: MUSIC_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (isSupportedMusicUpload(file)) {
      cb(null, true);
    } else {
      cb(new ServerError(
        'Unsupported audio format — accepted: MP3, WAV, M4A, OGG, FLAC',
        { status: 400, code: 'PIPELINE_MUSIC_UNSUPPORTED_FORMAT' },
      ));
    }
  },
});

// The audio stage status reflects whether the *VO line list* is ready, since
// music alone doesn't make an episode renderable. So music-only mutations
// leave status at 'empty' when no lines exist and bump to 'edited' otherwise.
const audioStatusAfterMusicChange = (stage) =>
  (stage.lines?.length ? 'edited' : 'empty');

// Attaching/generating/uploading a single track means "use this one track as
// the episode bed" — flip audioMode to 'uploaded-track' so the stitcher
// actually muxes it. Without this a new issue stays at the default 'per-clip'
// mode, which (correctly) ignores the music pointer, so the track would land on
// the issue but never play (issue #863). Only override the generated/silent
// modes when the user explicitly attaches a single track — those are deliberate
// strategy choices we shouldn't silently undo for an unrelated music write... but
// since all three routes ARE the "set the single track" action, the override is
// the user's intent. The delete route mirrors this: clearing the only track
// reverts an 'uploaded-track' issue to 'per-clip', leaving generated/silent be.
const audioModeAfterTrackSet = () => 'uploaded-track';
const audioModeAfterTrackClear = (stage) =>
  (stage.audioMode === 'uploaded-track' ? 'per-clip' : stage.audioMode);

router.get('/audio/music-library', asyncHandler(async (_req, res) => {
  res.json({ tracks: await listMusicLibrary() });
}));

// Local-OSS music generators available to the audio stage (Phase 4c.2).
// Returns every selectable backend under `engines` (each carrying its models,
// duration window and a `ready` flag for the opt-in venv) plus a `defaultEngine`
// id. The top-level `models`/`ready`/duration fields mirror the default engine
// for backward compatibility with pre-multi-engine clients.
router.get('/audio/music/generators', asyncHandler(async (_req, res) => {
  const engines = Object.values(ENGINES).map((engine) => ({
    id: engine.id,
    name: engine.name,
    models: engine.models.map(({ id, name }) => ({ id, name })),
    defaultModelId: engine.defaultModelId,
    defaultDurationSec: engine.defaultDurationSec,
    minDurationSec: engine.minDurationSec,
    maxDurationSec: engine.maxDurationSec,
    // The authoritative install-hint env var (e.g. INSTALL_AUDIOLDM2) so the UI
    // renders the exact command instead of re-deriving it from the engine id.
    installEnv: engine.installEnv,
    ready: isEngineReady(engine.id),
  }));
  const fallback = engines.find((e) => e.id === DEFAULT_ENGINE_ID) ?? engines[0];
  res.json({
    engines,
    defaultEngine: DEFAULT_ENGINE_ID,
    // Back-compat: flatten the default engine's fields to the top level.
    models: fallback.models,
    defaultModelId: fallback.defaultModelId,
    defaultDurationSec: fallback.defaultDurationSec,
    minDurationSec: fallback.minDurationSec,
    maxDurationSec: fallback.maxDurationSec,
    ready: fallback.ready,
  });
}));

// Every model id across all engines — the schema validates `modelId` against
// this union and `generateMusic` resolves it within the chosen engine (falling
// back to that engine's default for a mismatched id).
const ALL_MODEL_IDS = Object.values(ENGINES).flatMap((e) => e.models.map((m) => m.id));
// The widest duration window across engines; per-engine clamping happens in the
// service, so the schema just rejects absurd values.
const MAX_ENGINE_DURATION = Math.max(...Object.values(ENGINES).map((e) => e.maxDurationSec));

// Generate a background-music track with the selected backend and attach it to
// the issue as a `source: 'gen'` track. The generated WAV lands in the shared
// music library, so it's reusable across issues exactly like an upload.
const musicGenerateSchema = z.object({
  prompt: z.string().trim().min(1).max(800),
  engine: z.enum(Object.keys(ENGINES)).optional(),
  durationSec: z.number().min(1).max(MAX_ENGINE_DURATION).optional(),
  modelId: z.enum(ALL_MODEL_IDS).optional(),
});
router.post('/issues/:id/stages/audio/music/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(musicGenerateSchema, req.body ?? {});
  // Guard the (expensive) generation behind a 404 check first — generating a
  // multi-second clip only to discover the issue is gone wastes GPU time and
  // would orphan the WAV in the library.
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'audio');
  const gen = await generateMusic({
    prompt: body.prompt,
    engine: body.engine ?? DEFAULT_ENGINE_ID,
    durationSec: body.durationSec,
    modelId: body.modelId,
  }).catch((err) => { throw mapServiceError(err); });
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => ({
      status: audioStatusAfterMusicChange(current),
      audioMode: audioModeAfterTrackSet(),
      music: { source: MUSIC_SOURCE.GEN, trackFilename: gen.filename, label: gen.model },
      errorMessage: '',
    }),
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage, music: stage.music, durationSec: gen.durationSec, modelId: gen.modelId, engine: gen.engine });
}));

router.post('/issues/:id/stages/audio/music/upload', musicUpload, asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ServerError('No audio file uploaded', {
      status: 400, code: 'PIPELINE_MUSIC_NO_FILE',
    });
  }
  // Guard the filesystem write that follows — `updateStageWithLatest`'s 404
  // would otherwise orphan the imported file in the music library.
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const { filename, sizeBytes } = await importUploadedTrack(req.file.path, req.file.originalname);
  const label = typeof req.body?.label === 'string' && req.body.label.trim()
    ? req.body.label.trim()
    : null;
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => ({
      status: audioStatusAfterMusicChange(current),
      audioMode: audioModeAfterTrackSet(),
      music: { source: MUSIC_SOURCE.UPLOAD, trackFilename: filename, label },
      errorMessage: '',
    }),
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage, music: stage.music, sizeBytes });
}));

const musicAttachSchema = z.object({
  trackFilename: z.string().trim().min(1).max(500),
  label: z.string().trim().max(200).nullable().optional(),
});
router.post('/issues/:id/stages/audio/music/attach', asyncHandler(async (req, res) => {
  const body = validateRequest(musicAttachSchema, req.body ?? {});
  // Single-file stat instead of full library listing — one syscall vs. N+1.
  const found = await statMusicTrack(body.trackFilename);
  if (!found) {
    throw new ServerError('Music track not found in library', {
      status: 404, code: 'PIPELINE_MUSIC_NOT_FOUND',
    });
  }
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => ({
      status: audioStatusAfterMusicChange(current),
      audioMode: audioModeAfterTrackSet(),
      music: {
        source: MUSIC_SOURCE.LIBRARY,
        trackFilename: body.trackFilename,
        label: body.label?.trim() || found.label,
      },
      errorMessage: '',
    }),
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage, music: stage.music });
}));

router.delete('/issues/:id/stages/audio/music', asyncHandler(async (req, res) => {
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => ({
      status: audioStatusAfterMusicChange(current),
      audioMode: audioModeAfterTrackClear(current),
      music: null,
      errorMessage: '',
    }),
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage });
}));

// Whole-episode audio cues (issue #863, step 3). The 'generated' audioMode lays
// an ordered cues[] array — one cue per narrative arc beat — onto the episode
// timeline at stitch time. These two routes derive the cue list from the
// episode's own beats and render each cue's audio.

// Derive the per-arc cue list from the episode's OWN beat prose (stages.idea) +
// storyboard scene order. Replaces the existing cues[] unless force is false and
// cues already exist (mirrors the extract-lines / extract-scenes overwrite
// guard). Already-rendered cue audio is carried forward by label so re-deriving
// doesn't silently invalidate every rendered WAV.
const cuesGenerateSchema = z.object({
  engine: z.enum(Object.keys(ENGINES)).optional(),
  providerOverride: z.string().trim().max(80).optional(),
  modelOverride: z.string().trim().max(128).optional(),
  force: z.boolean().optional(),
});
router.post('/issues/:id/stages/audio/cues/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(cuesGenerateSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'audio');
  const existing = Array.isArray(issue.stages?.audio?.cues) ? issue.stages.audio.cues : [];
  if (existing.length > 0 && !body.force) {
    throw new ServerError(
      `Audio stage already has ${existing.length} cue${existing.length === 1 ? '' : 's'} — pass { force: true } to replace`,
      { status: 409, code: 'PIPELINE_AUDIO_CUES_EXIST' },
    );
  }
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });
  // Inherit the series LLM unless the client overrides — same provider/model
  // resolution as the other Pipeline LLM actions (extract-scenes / extract-canon).
  const { provider, model } = resolveSeriesLlmOverride(series, {
    overrideProvider: body.providerOverride,
    overrideModel: body.modelOverride,
  });
  const result = await deriveAudioCues(issue, {
    defaultEngine: body.engine ?? DEFAULT_ENGINE_ID,
    providerOverride: provider,
    modelOverride: model,
    series: { name: series.name, styleNotes: series.styleNotes },
  }).catch((err) => { throw mapServiceError(err); });
  // Carry forward already-rendered cue audio (matched by label) so a re-derive
  // doesn't drop WAVs the user already generated.
  const cues = preserveRenderedCues(result.cues, existing);
  // Deriving cues implies the user wants the episode-level generated soundtrack —
  // flip audioMode to 'generated' so the muxer picks up the cues at stitch time.
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    () => ({ audioMode: 'generated', cues, lastRunId: result.runId, errorMessage: '' }),
  ).catch((err) => { throw mapServiceError(err); });
  res.json({
    issue: updatedIssue, stage,
    cues: stage.cues,
    cueCount: stage.cues.length,
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
  });
}));

// Render one cue's audio via the generator-agnostic generateMusic contract,
// stamping trackFilename + durationSec back into that cue. Mirrors the per-line
// render route. The duration is the cue's placed timeline span (endSec-startSec)
// when placed, else the requested durationSec, else the engine default —
// per-engine clampDuration in generateMusic guards the final value.
const cueRenderSchema = z.object({
  engine: z.enum(Object.keys(ENGINES)).optional(),
  durationSec: z.number().min(1).max(MAX_ENGINE_DURATION).optional(),
  modelId: z.enum(ALL_MODEL_IDS).optional(),
});
router.post('/issues/:id/stages/audio/cues/:cueIdx/render', asyncHandler(async (req, res) => {
  const cueIdx = Number(req.params.cueIdx);
  if (!Number.isInteger(cueIdx) || cueIdx < 0) {
    throw new ServerError('cueIdx must be a non-negative integer', {
      status: 400, code: 'PIPELINE_AUDIO_BAD_INDEX',
    });
  }
  const body = validateRequest(cueRenderSchema, req.body ?? {});
  // Guard the expensive generation behind a 404 + range check first so we don't
  // burn GPU time only to discover the issue/cue is gone (orphaning the WAV).
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'audio');
  const cues = Array.isArray(issue.stages?.audio?.cues) ? issue.stages.audio.cues : [];
  const cue = cues[cueIdx];
  if (!cue) {
    throw new ServerError(`cueIdx ${cueIdx} out of range (have ${cues.length})`, {
      status: 404, code: 'PIPELINE_AUDIO_CUE_NOT_FOUND',
    });
  }
  if (!cue.prompt) {
    throw new ServerError('Cue has no prompt to render — derive cues first', {
      status: 400, code: 'PIPELINE_AUDIO_CUE_NO_PROMPT',
    });
  }
  // Duration priority: an explicit body override → the placed timeline span
  // (endSec-startSec when both are placed) → the engine default (generateMusic
  // resolves undefined to the engine's defaultDurationSec). Engine resolution
  // priority: body → the cue's own engine hint → the global default.
  const span = (typeof cue.startSec === 'number' && typeof cue.endSec === 'number' && cue.endSec > cue.startSec)
    ? cue.endSec - cue.startSec
    : undefined;
  const engine = body.engine ?? cue.engine ?? DEFAULT_ENGINE_ID;
  const gen = await generateMusic({
    prompt: cue.prompt,
    engine,
    durationSec: body.durationSec ?? span,
    modelId: body.modelId,
  }).catch((err) => { throw mapServiceError(err); });
  // Merge against the freshest persisted cue inside the write queue so a
  // concurrent re-derive can't clobber the render (the cue list is re-read here).
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => {
      const curCues = Array.isArray(current?.cues) ? current.cues : [];
      const target = curCues[cueIdx];
      if (!target) return {};
      const nextCues = [...curCues];
      nextCues[cueIdx] = {
        ...target,
        engine: gen.engine,
        trackFilename: gen.filename,
        durationSec: gen.durationSec,
      };
      return { cues: nextCues, errorMessage: '' };
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({
    issue: updatedIssue, stage, cueIdx,
    cue: stage.cues[cueIdx],
    trackFilename: gen.filename,
    durationSec: gen.durationSec,
    engine: gen.engine,
    modelId: gen.modelId,
  });
}));

// Deleting from the library leaves stale `music.trackFilename` pointers on
// issues so the user sees the broken playback and re-picks. Auto-purging
// would scan every issue on every delete; deferred until needed.
router.delete('/audio/music-library/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  const existed = await deleteMusicTrack(filename);
  res.json({ filename, deleted: existed });
}));

export default router;
