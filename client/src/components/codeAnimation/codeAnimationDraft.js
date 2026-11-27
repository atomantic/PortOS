import { BOARD_FOLLOW_UNIVERSE, BOARD_NONE } from '../media/UniverseMoodBoardPicker';
import { safeReadJsonStorage } from '../../lib/safeStorage';

export const DRAFT_KEY = 'portos.codeAnimation.draft';

const DEFAULT_DRAFT = {
  title: '',
  seedIdea: '',
  concept: '',
  cast: '',
  onScreenText: '',
  styleNotes: '',
  styleGrammarId: '',
  universeId: '',
  moodBoardChoice: BOARD_FOLLOW_UNIVERSE,
  includeMoodBoardImages: true,
  referenceImages: [],
  referenceVideo: null,
  audio: null,
  soundtrack: 'none',
  format: { durationSeconds: 20, aspectRatio: '16:9', resolution: '1080p', fps: 30 },
  renderer: 'auto',
  interactive: false,
  // The finished animation this draft forks and extends: { jobId, title, durationSeconds }.
  base: null,
};

// Brief fields where a blank from the brief writer means "nothing to add"
// rather than "clear it" (on-screen text, by contrast, can be deliberately none).
export const KEEP_ON_BLANK = new Set(['styleNotes', 'cast']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const readBase = (value) => (isRecord(value) && typeof value.jobId === 'string' && value.jobId
  ? { jobId: value.jobId, title: typeof value.title === 'string' ? value.title : '', durationSeconds: Number.isFinite(value.durationSeconds) ? value.durationSeconds : null }
  : null);

export const loadDraft = (key = DRAFT_KEY) => {
  const stored = safeReadJsonStorage(key, null);
  if (!isRecord(stored)) return DEFAULT_DRAFT;
  const format = isRecord(stored.format) ? stored.format : {};
  const referenceImages = Array.isArray(stored.referenceImages)
    ? stored.referenceImages
      .filter((image) => isRecord(image) && typeof image.filename === 'string' && image.filename.trim())
      .map((image) => ({
        filename: image.filename,
        label: typeof image.label === 'string' ? image.label : image.filename,
        note: typeof image.note === 'string' ? image.note : '',
        url: `/api/uploads/${encodeURIComponent(image.filename)}`,
      }))
    : [];
  let audio = null;
  if (isRecord(stored.audio)) {
    if (stored.audio.source === 'track' && typeof stored.audio.trackId === 'string' && stored.audio.trackId.trim()) {
      audio = {
        source: 'track',
        trackId: stored.audio.trackId.trim(),
        label: typeof stored.audio.label === 'string' ? stored.audio.label : 'Music track',
        durationSeconds: Number.isFinite(stored.audio.durationSeconds) ? stored.audio.durationSeconds : null,
        notes: typeof stored.audio.notes === 'string' ? stored.audio.notes : '',
        url: typeof stored.audio.url === 'string' ? stored.audio.url : '',
      };
    } else if (typeof stored.audio.filename === 'string' && stored.audio.filename.trim()) {
      audio = {
        source: 'upload',
        filename: stored.audio.filename.trim(),
        label: typeof stored.audio.label === 'string' ? stored.audio.label : stored.audio.filename,
        durationSeconds: Number.isFinite(stored.audio.durationSeconds) ? stored.audio.durationSeconds : null,
        notes: typeof stored.audio.notes === 'string' ? stored.audio.notes : '',
        url: `/api/uploads/${encodeURIComponent(stored.audio.filename)}`,
      };
    }
  }
  const stringField = (key) => typeof stored[key] === 'string' ? stored[key] : DEFAULT_DRAFT[key];
  return {
    ...DEFAULT_DRAFT,
    title: stringField('title'),
    seedIdea: stringField('seedIdea'),
    concept: stringField('concept'),
    cast: stringField('cast'),
    onScreenText: stringField('onScreenText'),
    styleNotes: stringField('styleNotes'),
    styleGrammarId: stringField('styleGrammarId'),
    universeId: stringField('universeId'),
    moodBoardChoice: stringField('moodBoardChoice'),
    includeMoodBoardImages: typeof stored.includeMoodBoardImages === 'boolean' ? stored.includeMoodBoardImages : DEFAULT_DRAFT.includeMoodBoardImages,
    referenceImages,
    audio,
    soundtrack: ['none', 'procedural'].includes(stored.soundtrack) ? stored.soundtrack : DEFAULT_DRAFT.soundtrack,
    format: {
      durationSeconds: Number.isFinite(format.durationSeconds) ? format.durationSeconds : DEFAULT_DRAFT.format.durationSeconds,
      aspectRatio: typeof format.aspectRatio === 'string' ? format.aspectRatio : DEFAULT_DRAFT.format.aspectRatio,
      resolution: typeof format.resolution === 'string' ? format.resolution : DEFAULT_DRAFT.format.resolution,
      fps: Number.isFinite(format.fps) ? format.fps : DEFAULT_DRAFT.format.fps,
    },
    renderer: stringField('renderer'),
    interactive: typeof stored.interactive === 'boolean' ? stored.interactive : DEFAULT_DRAFT.interactive,
    base: readBase(stored.base),
  };
};

// The mood-board choice as the server reads it: an ABSENT moodBoardId follows
// the universe's linked board, '' means none.
function moodBoardSelection(draft) {
  if (draft.moodBoardChoice === BOARD_NONE) return { moodBoardId: '' };
  if (draft.moodBoardChoice !== BOARD_FOLLOW_UNIVERSE) return { moodBoardId: draft.moodBoardChoice };
  return {};
}

// The draft → the server's brief shape.
export function toBrief(draft) {
  return {
    title: draft.title,
    concept: draft.concept,
    cast: draft.cast,
    onScreenText: draft.onScreenText,
    styleNotes: draft.styleNotes,
    styleGrammarId: draft.styleGrammarId || null,
    format: draft.format,
    renderer: draft.renderer,
    interactive: draft.interactive,
    soundtrack: draft.audio ? 'none' : draft.soundtrack,
    universeId: draft.universeId || null,
    includeMoodBoardImages: draft.includeMoodBoardImages,
    referenceImages: draft.referenceImages.map(({ filename, label, note }) => ({ filename, label, note })),
    referenceVideo: draft.referenceVideo
      ? { filename: draft.referenceVideo.filename, label: draft.referenceVideo.label, note: draft.referenceVideo.note }
      : null,
    audio: draft.audio
      ? draft.audio.source === 'track'
        ? {
          source: 'track',
          trackId: draft.audio.trackId,
          ...(draft.audio.label ? { label: draft.audio.label } : {}),
          ...(draft.audio.durationSeconds != null ? { durationSeconds: draft.audio.durationSeconds } : {}),
          notes: draft.audio.notes || '',
        }
        : {
          filename: draft.audio.filename,
          label: draft.audio.label,
          durationSeconds: draft.audio.durationSeconds ?? null,
          notes: draft.audio.notes,
        }
      : null,
    ...(draft.base ? { baseJobId: draft.base.jobId } : {}),
    ...moodBoardSelection(draft),
  };
}
// The draft → the brief-writer's input: art direction plus whatever the artist
// has typed so far, which the model builds on rather than discards.
export function toBriefIdeaInput(draft) {
  return {
    universeId: draft.universeId || null,
    ...moodBoardSelection(draft),
    styleGrammarId: draft.styleGrammarId || null,
    seedIdea: draft.seedIdea,
    current: {
      title: draft.title,
      concept: draft.concept,
      cast: draft.cast,
      onScreenText: draft.onScreenText,
      styleNotes: draft.styleNotes,
    },
    // The writer's prompt reads only these two — the rest of the format
    // conditions the picture, not the story.
    format: { durationSeconds: draft.format.durationSeconds, aspectRatio: draft.format.aspectRatio },
  };
}

export function draftFromJob(job) {
  const input = job?.input || {};
  const moodBoardChoice = input.moodBoardId === undefined
    ? BOARD_FOLLOW_UNIVERSE
    : input.moodBoardId
      ? input.moodBoardId
      : BOARD_NONE;
  return {
    ...DEFAULT_DRAFT,
    title: input.title || '',
    seedIdea: input.seedIdea || '',
    concept: input.concept || '',
    cast: input.cast || '',
    onScreenText: input.onScreenText || '',
    styleNotes: input.styleNotes || '',
    styleGrammarId: input.styleGrammarId || '',
    universeId: input.universeId || '',
    moodBoardChoice,
    includeMoodBoardImages: input.includeMoodBoardImages !== false,
    referenceImages: (Array.isArray(input.referenceImages) ? input.referenceImages : []).map((image) => ({
      ...image,
      url: `/api/uploads/${encodeURIComponent(image.filename)}`,
    })),
    referenceVideo: isRecord(input.referenceVideo) ? { ...input.referenceVideo, previewUrl: null } : null,
    audio: input.audio
      ? input.audio.source === 'track'
        ? {
          source: 'track',
          trackId: input.audio.trackId,
          label: input.audio.label || 'Music track',
          durationSeconds: input.audio.durationSeconds ?? null,
          notes: input.audio.notes || '',
          url: job.audioUrl || '',
        }
        : {
          source: 'upload',
          ...input.audio,
          url: `/api/uploads/${encodeURIComponent(input.audio.filename)}`,
        }
      : null,
    soundtrack: input.soundtrack || 'none',
    format: { ...DEFAULT_DRAFT.format, ...(input.format || {}) },
    renderer: input.renderer || 'auto',
    interactive: input.interactive === true,
    base: readBase(job.base),
  };
}
