import { MUSIC_VIDEO_MEDIA_MODES, musicVideoMediaMode } from './musicVideoMediaPolicy.js';
/**
 * Fully-autonomous Music Video — the pure vocabulary and transforms.
 *
 * A dependency-light leaf (the client's start drawer and the server's run
 * service import it directly, like musicVideoAutomation.js) so the stage list,
 * the brief shape and the Suno field limits cannot drift between the form, the
 * Zod schema and the orchestrator.
 *
 * One prompt drives the whole pipeline:
 *
 *   brief → lyrics → style → song → analyze → produce
 *
 *   brief    one LLM call turns the prompt into a title, a musical description,
 *            a Suno style line, a visual concept and a mood-board spec
 *   lyrics   original lyrics written against that description
 *   style    the mood board + visual concept are created from the prompt
 *   song     the PortOS Browser drives the Suno web UI, the song is downloaded
 *            into the music library and imported as a track — or, with
 *            `songSource: 'local'`, the on-device Music Designer engines render it
 *   analyze  beat / section analysis of the downloaded audio
 *   produce  the existing server-owned production run (footage tools) or the
 *            code-rendered video (code-only tools)
 *
 * Any of `lyrics` / `style` / `song` may be a CHECKPOINT: the run parks in
 * `awaiting-approval` until the director approves it. By default none are, so
 * the run is fully unattended.
 */

import { MUSIC_VIDEO_AUTOMATION_TOOL_IDS, normalizeMusicVideoEffort, normalizeMusicVideoLlm, normalizeMusicVideoLlmStages } from './musicVideoAutomation.js';
import { isStr, trimTo } from './textUtils.js';

export const AUTONOMOUS_STAGES = Object.freeze([
  Object.freeze({ id: 'brief', label: 'Creative brief' }),
  Object.freeze({ id: 'lyrics', label: 'Lyrics' }),
  Object.freeze({ id: 'style', label: 'Mood board & style' }),
  Object.freeze({ id: 'song', label: 'Song' }),
  Object.freeze({ id: 'analyze', label: 'Analyze song' }),
  Object.freeze({ id: 'produce', label: 'Produce video' }),
]);
export const AUTONOMOUS_STAGE_IDS = Object.freeze(AUTONOMOUS_STAGES.map((s) => s.id));

// The stages whose output the director may want to approve before the run
// spends anything further (Suno credits follow `lyrics`; image/video quota
// follows `song`). `cast` is the existing Cast & Sets check-in inside
// production — it is not a stage of this run, it flips that gate to review.
const AUTONOMOUS_STAGE_CHECKPOINT_IDS = Object.freeze(['lyrics', 'style', 'song']);
export const AUTONOMOUS_CHECKPOINT_IDS = Object.freeze([...AUTONOMOUS_STAGE_CHECKPOINT_IDS, 'cast']);

// Where the song comes from: the Suno web UI (needs a signed-in PortOS Browser
// and credits) or the on-device Music Designer engines (free, no browser).
export const AUTONOMOUS_SONG_SOURCES = Object.freeze(['suno', 'local']);

// A run in one of these states can still be resumed / approved.
export const AUTONOMOUS_LIVE_STATUSES = Object.freeze(['running', 'awaiting-approval', 'needs-human', 'stopped']);

export const AUTONOMOUS_PROMPT_MAX = 4000;
export const AUTONOMOUS_NAME_MAX = 200;
export const AUTONOMOUS_ORIGINS = Object.freeze(['manual', 'schedule']);

export const AUTONOMOUS_DEFAULT_LIMITS = Object.freeze({ maxGenerations: 40, maxReviewAttempts: 3 });
export const AUTONOMOUS_LIMIT_BOUNDS = Object.freeze({
  maxGenerations: Object.freeze({ min: 1, max: 500 }),
  maxReviewAttempts: Object.freeze({ min: 1, max: 10 }),
});

// Suno's custom-song form fields (v4.5+). Shaping text to these keeps a long
// LLM caption from being silently truncated — or rejected — by the page.
export const SUNO_LIMITS = Object.freeze({ title: 80, style: 1000, lyrics: 5000, excludeStyles: 500 });

// The Advanced form's optional controls a brief may set (`brief.suno`): the
// "Exclude styles" field, the vocal gender buttons and the model version menu.
export const SUNO_VOCAL_GENDERS = Object.freeze(['male', 'female']);
export const SUNO_MODEL_PATTERN = /^v\d+(\.\d+)?(-[a-z]+)?$/i;

// Free (local, un-metered) tools only, the same default a hand-made autopilot
// brief starts from — nothing paid is spent unless the operator opts in.
export const AUTONOMOUS_DEFAULT_TOOLS = Object.freeze(['image:local', 'video:local']);

// Normalize line endings, then trim and cap (non-strings become '').
const clean = (v, max) => trimTo(isStr(v) ? v.replace(/\r\n?/g, '\n') : v, max);
const int = (v, { min, max }, fallback) => (Number.isInteger(v) && v >= min && v <= max ? v : fallback);

/**
 * The brief's Suno form options, or null when none is set. `excludeStyles` keeps
 * an explicit '' (a director clearing the field Suno remembers from its last
 * draft) apart from absent (null = leave the field alone).
 */
export function normalizeSunoOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const excludeStyles = isStr(raw.excludeStyles) ? clean(raw.excludeStyles, SUNO_LIMITS.excludeStyles) : null;
  const vocalGender = SUNO_VOCAL_GENDERS.includes(raw.vocalGender) ? raw.vocalGender : null;
  const model = isStr(raw.model) && SUNO_MODEL_PATTERN.test(raw.model.trim()) ? raw.model.trim() : null;
  // Max Mode is Suno's higher-quality (more credits) render tier: true/false, or null to leave the form's default.
  const maxMode = typeof raw.maxMode === 'boolean' ? raw.maxMode : null;
  return excludeStyles === null && !vocalGender && !model && maxMode === null ? null : { excludeStyles, vocalGender, model, maxMode };
}

/**
 * How the video is produced, derived from the tool picks:
 *   `footage` — any image/video tool: the server-owned production run;
 *   `code`    — only `code:render`: a code-rendered video, no media generation.
 */
export const autonomousMedium = (tools) => (autonomousPool(tools).length ? 'footage' : 'code');

/** The production-run route pool for a tool list (+ optional per-tool model pins). */
export function autonomousPool(tools, models = {}) {
  return (Array.isArray(tools) ? tools : [])
    .filter((id) => isStr(id) && (id.startsWith('image:') || id.startsWith('video:')))
    .map((id) => {
      const [kind, mode] = id.split(':');
      const model = models?.[id]; // already trimmed by normalizeAutonomousSettings
      return { kind, mode, ...(model ? { model } : {}) };
    });
}

/**
 * The run settings a start request and the scheduled task share: everything
 * except the prompt itself. Unknown tool ids and checkpoint ids are dropped;
 * blank optional strings collapse to absent. Throws nothing — the route's Zod
 * schema owns rejection, this owns shape.
 */
function normalizeAutonomousSettings(raw = {}) {
  const picked = new Set(Array.isArray(raw.tools) ? raw.tools : AUTONOMOUS_DEFAULT_TOOLS);
  const tools = MUSIC_VIDEO_AUTOMATION_TOOL_IDS.filter((id) => picked.has(id));
  const models = {};
  for (const [id, model] of Object.entries(raw.models && typeof raw.models === 'object' ? raw.models : {})) {
    if (tools.includes(id) && isStr(model) && model.trim()) models[id] = model.trim().slice(0, 200);
  }
  const checkpoints = AUTONOMOUS_CHECKPOINT_IDS.filter((id) => Array.isArray(raw.checkpoints) && raw.checkpoints.includes(id));
  const budget = Number(raw.budgetUsd);
  // The direction LLM is a top-level providerId/model/effort on a start request but a
  // nested `llm` on a stored brief or the scheduled task's params (#9545 added effort).
  const llm = normalizeMusicVideoLlm(raw.providerId ? raw : raw.llm);
  const authoringProvider = clean(raw.authoring?.providerId, 200);
  const authoringModel = clean(raw.authoring?.model, 200);
  const authoringEffort = normalizeMusicVideoEffort(raw.authoring?.effort);
  return {
    mediaMode: MUSIC_VIDEO_MEDIA_MODES.includes(raw.mediaMode) ? raw.mediaMode : musicVideoMediaMode({ tools }),
    songSource: AUTONOMOUS_SONG_SOURCES.includes(raw.songSource) ? raw.songSource : AUTONOMOUS_SONG_SOURCES[0],
    // Suno only: when it cannot even take the request (signed out, no credits,
    // page changed), render the song locally instead of parking the run.
    localFallback: raw.localFallback === true,
    instrumental: raw.instrumental === true,
    guidance: clean(raw.guidance, 4000),
    tools,
    models,
    budgetUsd: raw.budgetUsd != null && Number.isFinite(budget) && budget >= 0 ? Math.min(budget, 100000) : null,
    limits: {
      maxGenerations: int(raw.limits?.maxGenerations, AUTONOMOUS_LIMIT_BOUNDS.maxGenerations, AUTONOMOUS_DEFAULT_LIMITS.maxGenerations),
      maxReviewAttempts: int(raw.limits?.maxReviewAttempts, AUTONOMOUS_LIMIT_BOUNDS.maxReviewAttempts, AUTONOMOUS_DEFAULT_LIMITS.maxReviewAttempts),
    },
    checkpoints,
    // An existing mood board to reuse instead of generating one (blank = generate).
    moodBoardId: clean(raw.moodBoardId, 64) || null,
    llm: llm ? { providerId: llm.providerId, model: llm.model, ...(llm.effort ? { effort: llm.effort } : {}) } : null,
    authoring: authoringProvider && authoringModel
      ? { providerId: authoringProvider, model: authoringModel, ...(authoringEffort ? { effort: authoringEffort } : {}) } : null,
    suno: normalizeSunoOptions(raw.suno),
    // A provider/model/effort per LLM stage (null = every stage uses `llm`).
    llmStages: normalizeMusicVideoLlmStages(raw.llmStages),
    // Review and revise the lyric draft in a second pass. A `llmStages.lyricsReview`
    // pin turns the pass on by itself; this asks for it on the direction LLM.
    lyricsReview: raw.lyricsReview === true,
  };
}

/** True when a run brief asks for the lyric review & revise pass. */
export const autonomousLyricsReviewEnabled = (brief) => brief?.lyricsReview === true || !!brief?.llmStages?.lyricsReview;

/** Normalize a start request into the brief a run stores: the settings plus prompt, name and origin. */
export function normalizeAutonomousBrief(raw = {}) {
  const origin = raw.origin && typeof raw.origin === 'object' ? raw.origin : {};
  return {
    prompt: clean(raw.prompt, AUTONOMOUS_PROMPT_MAX),
    name: clean(raw.name, AUTONOMOUS_NAME_MAX) || null,
    ...normalizeAutonomousSettings(raw),
    origin: {
      kind: AUTONOMOUS_ORIGINS.includes(origin.kind) ? origin.kind : 'manual',
      ideaId: clean(origin.ideaId, 80) || null,
      ideaTitle: clean(origin.ideaTitle, 200) || null,
    },
  };
}

/**
 * The scheduled task's saved configuration (`taskMetadata.musicVideoAutopilot`):
 * the run settings plus which brain ideas it may draw from. Returns null for a
 * non-object so the task-metadata sanitizer can drop it.
 */
export function normalizeAutopilotParams(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tags = (Array.isArray(raw.ideaTags) ? raw.ideaTags : [])
    .map((t) => clean(t, 50)).filter(Boolean).slice(0, 20);
  return { ...normalizeAutonomousSettings(raw), ideaTags: [...new Set(tags)] };
}

/** The stage a run goes to after `stage`, or null after the last. */
export function nextAutonomousStage(stage) {
  const i = AUTONOMOUS_STAGE_IDS.indexOf(stage);
  return i >= 0 && i < AUTONOMOUS_STAGE_IDS.length - 1 ? AUTONOMOUS_STAGE_IDS[i + 1] : null;
}

/**
 * Shape the generated text into what the Suno form accepts. Section tags in
 * the lyrics pass through unchanged (Suno reads `[Verse]` style tags); an
 * instrumental song sends no lyrics at all, and no vocal gender. The brief's
 * `suno` options ride along; null means "leave that control alone".
 */
export function sunoSongFields({ title, style, lyrics, instrumental = false, suno = null } = {}) {
  const options = normalizeSunoOptions(suno);
  return {
    title: clean(title, SUNO_LIMITS.title) || 'Untitled',
    style: clean(style, SUNO_LIMITS.style),
    lyrics: instrumental ? '' : clean(lyrics, SUNO_LIMITS.lyrics),
    instrumental,
    excludeStyles: options?.excludeStyles ?? null,
    vocalGender: instrumental ? null : options?.vocalGender ?? null,
    model: options?.model ?? null,
    maxMode: options?.maxMode ?? null,
  };
}

/** Suno song ids carried by `/song/<uuid>` links, de-duplicated in page order. */
const SUNO_SONG_ID = /\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
export function sunoSongIdsFromHrefs(hrefs) {
  const ids = [];
  for (const href of Array.isArray(hrefs) ? hrefs : []) {
    const m = isStr(href) ? SUNO_SONG_ID.exec(href) : null;
    if (m && !ids.includes(m[1].toLowerCase())) ids.push(m[1].toLowerCase());
  }
  return ids;
}

export const sunoSongUrl = (songId) => `https://suno.com/song/${encodeURIComponent(songId)}`;

/**
 * Choose the next brain idea to turn into a video: the OLDEST active idea no
 * earlier run used (a stable, drain-the-backlog order), optionally limited to
 * ideas carrying one of `tags`. Returns null when nothing is eligible.
 */
export function pickBrainIdea(ideas, { usedIdeaIds = [], tags = [] } = {}) {
  const used = new Set(usedIdeaIds);
  const wanted = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  const eligible = (Array.isArray(ideas) ? ideas : []).filter((idea) => {
    if (!idea?.id || used.has(idea.id) || idea.status === 'done') return false;
    if (!wanted.size) return true;
    return (idea.tags || []).some((t) => wanted.has(String(t).trim().toLowerCase()));
  });
  eligible.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  return eligible[0] || null;
}

/** A brain idea as the free-text prompt a run starts from. */
export function ideaToPrompt(idea) {
  return [idea?.title, idea?.oneLiner, idea?.notes].map((v) => clean(v, 2000)).filter(Boolean).join('\n\n').slice(0, AUTONOMOUS_PROMPT_MAX);
}
