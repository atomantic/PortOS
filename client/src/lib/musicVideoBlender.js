/**
 * Music Video "Blender film" render style: pure readings of the Blender state
 * the server answers for a project — what each shot's preview and final render
 * is doing, how far the film is, what a bulk render would cover — plus the
 * brief handed to a coding agent. No React and no requests.
 *
 * The rules the server also applies (setting limits, what a film option
 * accepts, which renders a bulk request takes, when the Shots step is done)
 * are imported from `server/lib/musicVideoBlender.js`, the one definition.
 */
import { formatCount, formatTimecode } from '../utils/formatters.js';
import {
  MUSIC_VIDEO_BLENDER_SETTING_LIMITS, MUSIC_VIDEO_BLENDER_SOURCE_PATH, MUSIC_VIDEO_BLENDER_TEXT_EXTENSIONS,
  blenderEffectiveOptions, blenderOptionValueProblem, blenderRenderWanted, blenderShotsReady, summarizeBlenderShots,
} from '../../../server/lib/musicVideoBlender.js';

export { blenderEffectiveOptions, blenderShotsReady, summarizeBlenderShots };
export const BLENDER_SOURCE_PATH = MUSIC_VIDEO_BLENDER_SOURCE_PATH;
export const BLENDER_TEXT_EXTENSIONS = MUSIC_VIDEO_BLENDER_TEXT_EXTENSIONS.map((extension) => `.${extension}`);

export const BLENDER_SKILL_NAME = 'portos-music-video-blender';
export const BLENDER_TAB_IDS = ['shots', 'cut', 'settings', 'files', 'jobs'];
// The search params that say which tab is open and which job's log is shown.
export const BLENDER_TAB_PARAM = 'btab';
export const BLENDER_JOB_PARAM = 'bjob';

export const BLENDER_ENGINES = [
  { id: 'BLENDER_EEVEE_NEXT', label: 'EEVEE', note: 'Real-time GPU renderer: seconds per frame.' },
  { id: 'CYCLES', label: 'Cycles', note: 'Path traced: slower, physically based light.' },
];

export const BLENDER_NOTE_STATUSES = [
  ['todo', 'To do'],
  ['wip', 'In progress'],
  ['review', 'Ready for review'],
  ['approved', 'Approved'],
];
export const BLENDER_NOTE_MAX_LENGTH = 4000;

// The server's bounds, so a value it would refuse is named beside its field; how each field steps is the form's own.
const SETTING_STEPS = {
  width: { step: 2, even: true }, height: { step: 2, even: true }, fps: { step: 1, integer: true }, previewScale: { step: 0.05 },
  previewSamples: { step: 1, integer: true }, finalSamples: { step: 1, integer: true }, concurrency: { step: 1, integer: true },
};
export const BLENDER_SETTING_LIMITS = Object.fromEntries(Object.entries(MUSIC_VIDEO_BLENDER_SETTING_LIMITS)
  .map(([field, limit]) => [field, { ...limit, ...SETTING_STEPS[field] }]));

const SETTING_LABELS = {
  width: 'Width', height: 'Height', fps: 'Frame rate', previewScale: 'Preview scale',
  previewSamples: 'Preview samples', finalSamples: 'Final samples', concurrency: 'Parallel renders',
};

/** `{ field: message }` for every setting the server would refuse; empty when the draft can be saved. */
export function blenderSettingsProblems(settings = {}) {
  const problems = {};
  for (const [field, limit] of Object.entries(BLENDER_SETTING_LIMITS)) {
    const value = settings[field];
    if (value === undefined) continue;
    const label = SETTING_LABELS[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) problems[field] = `${label} needs a number.`;
    else if (value < limit.min || value > limit.max) problems[field] = `${label} must be between ${limit.min} and ${limit.max}.`;
    else if ((limit.integer || limit.even) && !Number.isInteger(value)) problems[field] = `${label} must be a whole number.`;
    else if (limit.even && value % 2 !== 0) problems[field] = `${label} must be an even number.`;
  }
  if (settings.engine !== undefined && !BLENDER_ENGINES.some((engine) => engine.id === settings.engine)) {
    problems.engine = 'Choose EEVEE or Cycles.';
  }
  return problems;
}

/**
 * Only the fields of `draft` that differ from the saved settings: the body a
 * settings save sends. Film options are sent key by key (`{ options: { key:
 * value } }`); see `blenderOptionChanges`.
 */
export function changedBlenderSettings(saved = {}, draft = {}) {
  const changed = {};
  for (const [field, value] of Object.entries(draft)) {
    if (field !== 'options' && value !== saved[field]) changed[field] = value;
  }
  return changed;
}

// ---- film options ------------------------------------------------------------

/**
 * A film's options as the Settings form shows them: each declared option with
 * the value in effect (`value`: the draft, else the saved value, else the
 * film's default), whether it differs from what is saved (`dirty`) and why the
 * server would refuse it (`problem`, null when it would not).
 */
export function blenderOptionFields(declared, saved = {}, draft = {}) {
  const current = blenderEffectiveOptions(declared, saved);
  return (Array.isArray(declared) ? declared : []).map((option) => {
    const value = Object.hasOwn(draft, option.key) ? draft[option.key] : current[option.key];
    const problem = blenderOptionValueProblem(option, value);
    return { ...option, value, dirty: value !== current[option.key], isDefault: value === option.default, problem: problem ? `${option.label || option.key} ${problem}.` : null };
  });
}

/**
 * The `options` part of a settings save: the changed keys only. A value put
 * back to the film's default is sent as null, which clears the saved value, so
 * the project follows the film if its default changes later.
 */
export function blenderOptionChanges(declared, saved = {}, draft = {}) {
  return Object.fromEntries(blenderOptionFields(declared, saved, draft)
    .filter((field) => field.dirty && !field.problem)
    .map((field) => [field.key, field.isDefault ? null : field.value]));
}

// ---- jobs ------------------------------------------------------------------

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'encoding']);
const TERMINAL_JOB_STATUSES = new Set(['done', 'error', 'canceled']);

export const isBlenderJobActive = (job) => ACTIVE_JOB_STATUSES.has(job?.status);
export const isBlenderJobTerminal = (job) => TERMINAL_JOB_STATUSES.has(job?.status);

/** 0..100 from the frames rendered so far, or null while the total is unknown (queued, describing, assembling). */
export function blenderJobPercent(job) {
  if (!job || !(job.total > 0) || !Number.isFinite(job.index)) return null;
  return Math.max(0, Math.min(100, Math.round((job.index / job.total) * 100)));
}

/** The job list with `job` applied: its entry updated in place, or added last (queue order) when it is new. */
export function mergeBlenderJob(jobs, job) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!job?.id) return list;
  const index = list.findIndex((entry) => entry.id === job.id);
  if (index === -1) return [...list, job];
  const next = list.slice();
  next[index] = { ...list[index], ...job };
  return next;
}

const JOB_ORDER = { running: 0, encoding: 0, queued: 1 };
const jobTime = (job) => Date.parse(job.finishedAt || job.startedAt || '') || 0;

/** Jobs for display: the ones at work, then the queue in order, then finished jobs newest first. */
export function sortBlenderJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).map((job, index) => ({ job, index })).sort((a, b) => {
    const rankA = JOB_ORDER[a.job.status] ?? 2;
    const rankB = JOB_ORDER[b.job.status] ?? 2;
    if (rankA !== rankB) return rankA - rankB;
    if (rankA === 2) return jobTime(b.job) - jobTime(a.job) || a.index - b.index;
    return a.index - b.index;
  }).map(({ job }) => job);
}

const JOB_KIND_LABELS = { sync: 'Sync shots', render: 'Render', cut: 'Assemble cut' };
const QUALITY_LABELS = { still: 'still', preview: 'preview', final: 'final' };

/** "Render preview · s010", "Sync shots", "Assemble cut · final". */
export function blenderJobTitle(job) {
  const kind = JOB_KIND_LABELS[job?.kind] || 'Job';
  const quality = QUALITY_LABELS[job?.quality];
  const head = job?.kind === 'render' && quality ? `${kind} ${quality}` : kind;
  return [head, job?.kind === 'cut' ? quality : null, job?.shotId].filter(Boolean).join(' · ');
}

export const BLENDER_JOB_STATUS_LABELS = {
  queued: 'Queued', running: 'Rendering', encoding: 'Encoding', done: 'Done', error: 'Failed', canceled: 'Canceled',
};

// ---- shots -----------------------------------------------------------------

// The server's `staleReasons`, in the director's words.
const STALE_REASON_TEXT = {
  source: 'its scripts changed', timing: 'the shot moved on the song', handles: 'its handles changed', settings: 'the render settings changed', options: 'a film option changed', song: 'the song context changed',
};

/** Why a render is out of date: "its scripts changed and a film option changed". */
export function blenderStaleReason(render) {
  const given = (render?.staleReasons || []).map((reason) => STALE_REASON_TEXT[reason]).filter(Boolean);
  return given.length ? given.join(' and ') : 'its scripts or settings changed';
}

const STATUS_VIEW = {
  none: { text: 'none', tone: 'muted' },
  queued: { text: 'queued', tone: 'accent' },
  rendering: { text: 'rendering', tone: 'accent' },
  encoding: { text: 'encoding', tone: 'accent' },
  done: { text: 'done', tone: 'success' },
  stale: { text: 'stale', tone: 'warning' },
  partial: { text: 'partial', tone: 'warning' },
  failed: { text: 'failed', tone: 'error' },
  canceled: { text: 'canceled', tone: 'muted' },
};

/**
 * One shot's render at one quality (`'preview'` | `'final'`), as the list and
 * the buttons read it: `{ status, text, tone, percent, job, render, detail }`.
 * A job in flight wins over the render on disk; `detail` says why a render is
 * stale, how far a partial one got, or what a failed job reported.
 */
export function blenderShotRenderStatus(state, shotId, quality) {
  const jobs = (state?.jobs || []).filter((job) => job.kind === 'render' && job.shotId === shotId && job.quality === quality);
  const render = state?.renders?.[shotId]?.[quality] || null;
  const job = jobs.find(isBlenderJobActive) || null;
  const view = (status, extra = {}) => ({ status, ...STATUS_VIEW[status], percent: null, job, render, detail: null, ...extra });
  if (job) {
    if (job.status === 'queued') return view('queued');
    if (job.status === 'encoding') return view('encoding');
    const percent = blenderJobPercent(job);
    return view('rendering', { percent, text: percent == null ? 'rendering' : `rendering ${percent}%` });
  }
  if (render?.complete) {
    return render.stale ? view('stale', { detail: `Out of date: ${blenderStaleReason(render)}.` }) : view('done');
  }
  const latest = jobs.filter(isBlenderJobTerminal).reduce((last, entry) => !last || jobTime(entry) >= jobTime(last) ? entry : last, null);
  if (latest?.status === 'error') return view('failed', { job: latest, detail: latest.error || 'The render failed.' });
  if (render) {
    const got = render.partialFrames ?? 0;
    return view('partial', { detail: render.frames > 0 ? `${formatCount(got)} of ${formatCount(render.frames)} frames rendered.` : 'The render did not finish.' });
  }
  if (latest?.status === 'canceled') return view('canceled', { job: latest, detail: 'The render was canceled.' });
  return view('none');
}

/**
 * What a shot can play: `{ quality, render, qualities }`, or null with nothing
 * finished. `preferred` picks a quality when it has a finished render;
 * otherwise the most recently finished one plays (the final on a tie).
 */
export function blenderShotPlayable(state, shotId, preferred = null) {
  const renders = state?.renders?.[shotId];
  const finished = ['preview', 'final'].filter((quality) => renders?.[quality]?.complete && renders[quality].file);
  if (!finished.length) return null;
  const at = (quality) => Date.parse(renders[quality].finishedAt || '') || 0;
  const newest = finished.length === 2 && at('preview') > at('final') ? 'preview' : finished.at(-1);
  const quality = finished.includes(preferred) ? preferred : newest;
  return { quality, render: renders[quality], qualities: finished };
}

/**
 * The video a shot shows in the live film preview, from its renders
 * (`state.renders[shotId]`): its current final, else its current preview, else
 * a final that went out of date, else such a preview. `{ quality, stale,
 * render }`, or null when no render of it has finished.
 */
export function blenderShotClip(renders) {
  const finished = (quality) => (renders?.[quality]?.complete && renders[quality].file ? renders[quality] : null);
  const final = finished('final');
  const preview = finished('preview');
  const render = [final, preview].find((candidate) => candidate && !candidate.stale) || final || preview;
  return render ? { quality: render === final ? 'final' : 'preview', stale: render.stale === true, render } : null;
}

/**
 * The live film preview's clip for each Board scene, keyed by scene id:
 * `{ shotId, quality, stale, file, version }`. `version` changes when the shot
 * is rendered again into the same file. A scene whose shot has no finished
 * render has no entry. `sceneMap` is the project's `blender.sceneMap`
 * (`{ shotId: sceneId }`); the synced shots carry the same mapping as `sceneId`.
 */
export function blenderSceneClips({ shots, renders, sceneMap = null }) {
  const clips = new Map();
  for (const shot of Array.isArray(shots) ? shots : []) {
    const sceneId = sceneMap?.[shot.id] || shot.sceneId;
    const clip = sceneId ? blenderShotClip(renders?.[shot.id]) : null;
    if (clip) clips.set(sceneId, { shotId: shot.id, quality: clip.quality, stale: clip.stale, file: clip.render.file, version: clip.render.finishedAt || '' });
  }
  return clips;
}

export const BLENDER_SHOT_STAGES = [
  ['final', 'Final done'],
  ['preview', 'Preview done'],
  ['stale', 'Out of date'],
  ['rendering', 'Rendering'],
  ['failed', 'Failed'],
  ['none', 'Not rendered'],
];

/** How far one shot is, as a single word for the timeline: a job at work, a failure, the final, a stale render, the preview, or nothing. */
export function blenderShotStage(state, shotId) {
  const preview = blenderShotRenderStatus(state, shotId, 'preview').status;
  const final = blenderShotRenderStatus(state, shotId, 'final').status;
  const working = ['queued', 'rendering', 'encoding'];
  if (working.includes(preview) || working.includes(final)) return 'rendering';
  if (final === 'failed' || (final === 'none' && preview === 'failed')) return 'failed';
  if (final === 'done') return 'final';
  if (final === 'stale' || preview === 'stale') return 'stale';
  if (preview === 'done') return 'preview';
  return 'none';
}

const stillKey = (shotId, file) => `blender-still:${shotId}:${file}`;
export const blenderStillPreviewKey = stillKey;

/**
 * Lightbox items for every rendered still, in shot order. They are files in
 * the Blender workspace, not gallery images, so they carry no `filename`.
 * `mediaUrl(path)` builds the URL the still is served from.
 */
export function blenderStillPreviewItems(state, mediaUrl) {
  const items = [];
  for (const shot of state?.manifest?.shots || []) {
    for (const still of state?.renders?.[shot.id]?.stills || []) {
      if (!still?.file) continue;
      const url = mediaUrl(still.file);
      const caption = `${shot.label || shot.id} · still at ${formatTimecode(still.timeSec ?? shot.start ?? 0)}`;
      items.push({ kind: 'image', key: stillKey(shot.id, still.file), previewUrl: url, thumbnailUrl: url, downloadUrl: url, prompt: caption, label: caption });
    }
  }
  return items;
}

/**
 * The media path of a shot's picture for the list, or null when nothing was
 * rendered: the preview's poster (a small JPEG the server makes with the shot
 * video), else its newest still thumbnail, else the final's poster.
 */
export function blenderShotThumbPath(state, shot) {
  const renders = state?.renders?.[shot?.id];
  if (!renders) return null;
  // Stills arrive newest first.
  return renders.preview?.poster || renders.stills?.[0]?.thumbnail || renders.stills?.[0]?.file || renders.final?.poster || null;
}

/**
 * How far the film is: the server's own Shots-step reading
 * (`{ total, finalReady, ready }`, as `project.blenderShots`) plus what the
 * panel also names: finals out of date (`finalStale`) or not rendered
 * (`finalMissing`), and current previews (`previewReady`).
 */
export function blenderFilmSummary(state) {
  const shots = state?.manifest?.shots || [];
  const renders = state?.renders || {};
  const summary = summarizeBlenderShots(shots, renders);
  const finalStale = shots.filter((shot) => renders[shot.id]?.final?.complete && renders[shot.id].final.stale).length;
  return {
    ...summary, finalStale, finalMissing: summary.total - summary.finalReady - finalStale,
    previewReady: shots.filter((shot) => renders[shot.id]?.preview?.complete && !renders[shot.id].preview.stale).length,
  };
}

// What each scope renders, as the server decides it (`blenderRenderWanted`).
export const BLENDER_BULK_SCOPES = [
  ['needed', 'Missing or out of date'],
  ['stale', 'Out of date only'],
  ['all', 'Every shot (re-render)'],
];
const BULK_SCOPE_FLAGS = { needed: {}, stale: { onlyStale: true }, all: { force: true } };

/**
 * What a bulk render of `quality` covers under `scope`: the request `body`
 * and the shots this page expects it to render (`shotIds`, from the state on
 * screen, by the server's own rule — it decides again when the request lands).
 * A shot already queued or rendering keeps its job and is not counted.
 */
export function blenderBulkPlan(state, quality, scope) {
  const flags = BULK_SCOPE_FLAGS[scope] || BULK_SCOPE_FLAGS.needed;
  const working = new Set((state?.jobs || []).filter((job) => job.kind === 'render' && job.quality === quality && isBlenderJobActive(job)).map((job) => job.shotId));
  const shotIds = (state?.manifest?.shots || [])
    .filter((shot) => !working.has(shot.id) && blenderRenderWanted(state?.renders?.[shot.id]?.[quality], flags))
    .map((shot) => shot.id);
  return { body: { quality, ...flags }, shotIds };
}

/** Above this many shots a bulk render asks first. */
export const BLENDER_BULK_CONFIRM_ABOVE = 10;

/** The song's length for the timeline: the analysis's, else where the last shot ends. */
export function blenderSongDuration(project, state) {
  const analyzed = project?.audioAnalysis?.durationSec;
  if (analyzed > 0) return analyzed;
  return Math.max(0, ...(state?.manifest?.shots || []).map((shot) => shot.end || 0));
}

/** "0:04.50–0:09.00 · 4.5s · 108 frames" */
export function blenderShotTiming(shot) {
  const seconds = Math.max(0, (shot.end || 0) - (shot.start || 0));
  const parts = [`${formatTimecode(shot.start || 0)}–${formatTimecode(shot.end || 0)}`, `${Number(seconds.toFixed(2))}s`];
  if (Number.isFinite(shot.frames)) parts.push(`${formatCount(shot.frames)} ${shot.frames === 1 ? 'frame' : 'frames'}`);
  return parts.join(' · ');
}

/**
 * Why a Blender run (a sync or a render) cannot start right now: `{ message,
 * tab }` naming the panel tab that settles it, or null when it can. Blender
 * setup comes first; then anything unsaved that the run would read from the
 * server or the disk: the render settings and the source files.
 */
export function blenderRenderBlocker(state, { settingsDirty = false, settingsSaving = false, unsavedFiles = [], filesSaving = false } = {}) {
  const blocked = (message, tab = 'settings') => ({ message, tab });
  if (!state) return blocked('Loading the Blender film…');
  if (state.tool?.executionMode && state.tool.executionMode !== 'trusted-local') return blocked('Blender film renders need Trusted local execution. Change it in Blender setup under Settings.');
  if (!state.tool?.ready) return blocked(state.tool?.reason || 'Blender is not set up yet. Open Settings to check it.');
  if (settingsSaving) return blocked('Saving the render settings…');
  if (settingsDirty) return blocked('Save or discard the render settings first.');
  if (filesSaving) return blocked('Saving a source file…', 'files');
  if (unsavedFiles.length) {
    return blocked(`Save or discard your changes to src/${unsavedFiles[0]}${unsavedFiles.length > 1 ? ` and ${formatCount(unsavedFiles.length - 1)} more` : ''} first.`, 'files');
  }
  return null;
}

/**
 * Why a shot render cannot start: whatever holds every run back (`runBlocker`),
 * else a frame rate the shots were not synced at (the server refuses those
 * renders: the shots sit on the old frame grid until the next sync).
 */
export function blenderShotRenderBlocker(state, runBlocker) {
  if (runBlocker) return runBlocker;
  const synced = state?.manifest?.fps;
  const current = state?.settings?.fps;
  if (Number.isFinite(synced) && Number.isFinite(current) && synced !== current) {
    return { message: `The frame rate changed from ${synced} to ${current} since the last sync. Sync shots from scripts again before rendering.`, tab: 'settings' };
  }
  return null;
}

/** The film's sync as the page shows it: the one at work, else the last one that ended; null before any. */
export function blenderSyncJob(state) {
  const syncs = (state?.jobs || []).filter((job) => job.kind === 'sync');
  return syncs.find(isBlenderJobActive) || syncs.at(-1) || null;
}

// ---- agent brief -----------------------------------------------------------

const engineLabel = (id) => BLENDER_ENGINES.find((engine) => engine.id === id)?.label || id || 'unset';

/**
 * A ready-to-paste brief for a coding agent authoring this film: where the
 * workspace is, the film contract, the review loop and the routes. Built from
 * the state on screen; nothing is fetched.
 */
export function blenderAgentBrief({ projectId, state }) {
  const settings = state?.settings || {};
  const base = `/api/music-video/${projectId}/blender`;
  // Where this machine keeps it; the data-relative label only when the server did not say.
  const workspace = state?.workspace?.path || state?.workspace?.dir || `data/music-video/${projectId}/blender`;
  const shots = state?.manifest?.shots || [];
  const summary = blenderFilmSummary(state);
  const stateLine = shots.length
    ? `${formatCount(shots.length)} shots synced; ${formatCount(summary.previewReady)} current previews and ${formatCount(summary.finalReady)} current finals.`
    : state?.workspace?.hasFilm ? 'src/film.py exists; no shots synced yet (run sync).' : 'No src/film.py yet (create the starter workspace or write one).';
  const options = blenderOptionFields(state?.manifest?.options, settings.options);
  const optionsLine = options.length
    ? `Film options now: ${options.map((option) => `${option.key}=${JSON.stringify(option.value)}`).join(', ')}.`
    : 'Film options: none declared.';
  return [
    'You are authoring a Blender film for a PortOS music video.',
    '',
    `Skill: ${BLENDER_SKILL_NAME} (read it first: it holds the full contract and the review loop).`,
    `Project id: ${projectId}`,
    `Workspace on this machine: ${workspace}`,
    '  src/film.py      the entry point you write (durable, backed up)',
    '  song.json        song context PortOS writes before every job: duration, beats, sections, lyric cues with word timings',
    '  manifest.json    the last synced shot list',
    '  renders/         PortOS output, regenerable: never edit it',
    '',
    'Film contract (Python inside Blender 5 or later), in src/film.py:',
    '  describe(ctx) -> {"title": str, "shots": [{"id", "label", "start", "end", "handles"?: {"in", "out"}, "set", "summary", "action", "staging", "camera", "transition", "deps"}], "options"?: [...]}',
    '    Shots in time order, not overlapping, 0 <= start < end <= song duration, every boundary on the frame grid (k / fps), at most 400 shots.',
    '    "handles" (optional, 0..4 s each on the frame grid) renders [start - in, start) and [end, end + out) for dissolves and beat toggles; shots with handles must stay valid over those times.',
    '    Shot ids match [a-z0-9][a-z0-9_-]{0,39}. "deps" lists the files or folders under src/ a shot reads; a change there marks its renders out of date.',
    '    "options" (at most 24) is what the director can set in PortOS: {"key", "label", "type": "choice"|"boolean"|"number"|"text", "default", "help"?, "choices"?: [{"value","label"}], "min"?, "max"?, "step"?}.',
    '  build_shot(ctx, shot) -> None       build the bpy scene for one shot: objects, lights, camera',
    '  frame(ctx, shot, t, frame) -> None  optional: pose everything for song time t before each frame renders',
    "  ctx: song, options, fps, width, height (already scaled), scale, samples, quality ('still' | 'preview' | 'final' | 'describe'), engine, workspace, src, out_dir, shot, log(msg), seconds_to_frame(t), frame_to_seconds(f)",
    '    ctx.options is a dict: each declared default, overlaid with the value the director saved. Changing one marks every render out of date.',
    '  Helpers: portos_film.music (beats, downbeats, nearest_beat, beats_between, cue_words, words_between, envelope) and portos_film.timing (ease, clamp, remap, stepped).',
    '  These scripts run as trusted operator code with host access. Only run source you trust.',
    '',
    `Render settings: ${settings.width || '?'}x${settings.height || '?'} at ${settings.fps || '?'} fps, ${engineLabel(settings.engine)}; preview scale ${settings.previewScale ?? '?'} with ${settings.previewSamples ?? '?'} samples; final ${settings.finalSamples ?? '?'} samples.`,
    optionsLine,
    `Now: ${stateLine}`,
    '',
    'Review loop: edit src/ -> sync -> stills -> preview shots -> preview cut -> director notes -> finals -> final render.',
    'The final render still needs the art guide, verified lyric timing and an approved storyboard.',
    '',
    `Routes (base ${base}; from a terminal session use node scripts/portos-api.js):`,
    '  GET    (base)                 the full state: settings, tool, workspace, manifest, renders, cuts, jobs, notes',
    '  PUT    /settings              partial settings; film option values as {"options": {"<key>": value}} (null clears one back to its default)',
    '  POST   /workspace             {"template":"starter"} scaffolds src/ when there is no film.py',
    '  GET    /files                 list src/',
    '  GET    /file?path=<p>         read one text source file',
    '  PUT    /file                  {"path","content"} write one text source file',
    '  DELETE /file?path=<p>         remove one source file',
    '  POST   /sync                  {"replaceScenes"?} -> 202 {"job"}: runs describe in the background, writes manifest.json, mirrors the shots to storyboard scenes.',
    '                                Read the state until that job is done; a failed one carries "error", "problems" (every refused shot or option) and "logFile".',
    '  POST   /render                {"shotIds"?, "quality": "still"|"preview"|"final", "times"?, "force"?, "onlyStale"?} -> 202 {"jobs", "skipped"}',
    '                                Renders what is not rendered or out of date; "force" re-renders current shots too; "onlyStale" takes only renders that exist and went out of date.',
    '  POST   /jobs/<jobId>/cancel   cancel one job;  POST /cancel  cancel every job of this project',
    '  POST   /cut                   {"quality": "preview"|"final", "animatic"?, "filmLook"?} assemble a work-in-progress cut with the song',
    '  PUT    /shots/<shotId>/note   {"text"?, "status"?: "todo"|"wip"|"review"|"approved"}',
    '  POST   /shots/<shotId>/open   open the saved .blend in Blender',
    '  GET    /media?path=<p>        a file under renders/ (mp4, png, jpg, log)',
    '  GET    /usage                 what the workspace takes on disk;  POST /frames/clear  remove the frames of finished renders (their videos stay)',
    "Progress is pushed on the Socket.IO channel music-video:blender as { projectId, kind: 'job' | 'state', job? }.",
    'Rendering needs Blender set to Trusted local in PortOS; in contained mode every run route answers 409.',
  ].join('\n');
}
