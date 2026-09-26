import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Copy, FileCode2, Globe, ImagePlus, LoaderCircle, Music2, PenLine, Sparkles, Wand2, X } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import PageHeader from '../components/PageHeader';
import ProviderModelSelector from '../components/ProviderModelSelector';
import AlbumTrackPicker from '../components/music/AlbumTrackPicker';
import CodeAnimationPreview from '../components/codeAnimation/CodeAnimationPreview';
import InfiniteScrollFooter from '../components/ui/InfiniteScrollFooter';
import useProviderModels from '../hooks/useProviderModels';
import { usePagedCollection } from '../hooks/usePagedCollection';
import { useSocketSubscription } from '../hooks/useSocketSubscription';
import { useSocketResource } from '../hooks/useSocketResource';
import socket from '../services/socket';
import toast from '../components/ui/Toast';
import {
  buildCodeAnimationPrompt,
  generateCodeAnimationBrief,
  getCodeAnimationJob,
  getCodeAnimationOptions,
  listCodeAnimationJobPage,
  listMoodBoardNames,
  listTracks,
  listUniverseNames,
  listUniverseStyles,
  startCodeAnimationGeneration,
  uploadFile,
} from '../services/api';
import { copyToClipboard } from '../lib/clipboard';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../lib/safeStorage';
import { readFileAsBase64, UPLOAD_IMAGE_ACCEPT, validateImageFile } from '../utils/fileUpload';
import { formatCount, timeAgo } from '../utils/formatters';

const DRAFT_KEY = 'portos.codeAnimation.draft';
const JOB_EVENTS = ['code-animation:changed'];
// Mood-board choice sentinels: follow the universe's linked board, or none.
const BOARD_FOLLOW_UNIVERSE = 'universe';
const BOARD_NONE = 'none';

const DEFAULT_DRAFT = {
  title: '',
  seedIdea: '',
  concept: '',
  cast: '',
  onScreenText: '',
  styleNotes: '',
  universeId: '',
  moodBoardChoice: BOARD_FOLLOW_UNIVERSE,
  includeMoodBoardImages: true,
  referenceImages: [],
  audio: null,
  soundtrack: 'none',
  format: { durationSeconds: 20, aspectRatio: '16:9', resolution: '1080p', fps: 30 },
  renderer: 'auto',
  interactive: false,
};

// Brief fields where a blank from the brief writer means "nothing to add"
// rather than "clear it" (on-screen text, by contrast, can be deliberately none).
const KEEP_ON_BLANK = new Set(['styleNotes', 'cast']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const loadDraft = () => {
  const stored = safeReadJsonStorage(DRAFT_KEY, null);
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
function toBrief(draft) {
  return {
    title: draft.title,
    concept: draft.concept,
    cast: draft.cast,
    onScreenText: draft.onScreenText,
    styleNotes: draft.styleNotes,
    format: draft.format,
    renderer: draft.renderer,
    interactive: draft.interactive,
    soundtrack: draft.audio ? 'none' : draft.soundtrack,
    universeId: draft.universeId || null,
    includeMoodBoardImages: draft.includeMoodBoardImages,
    referenceImages: draft.referenceImages.map(({ filename, label, note }) => ({ filename, label, note })),
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
    ...moodBoardSelection(draft),
  };
}
// The draft → the brief-writer's input: art direction plus whatever the artist
// has typed so far, which the model builds on rather than discards.
function toBriefIdeaInput(draft) {
  return {
    universeId: draft.universeId || null,
    ...moodBoardSelection(draft),
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

function draftFromJob(job) {
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
    universeId: input.universeId || '',
    moodBoardChoice,
    includeMoodBoardImages: input.includeMoodBoardImages !== false,
    referenceImages: (Array.isArray(input.referenceImages) ? input.referenceImages : []).map((image) => ({
      ...image,
      url: `/api/uploads/${encodeURIComponent(image.filename)}`,
    })),
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
  };
}

function galleryJob(job) {
  return {
    id: job.id,
    status: job.status,
    title: job.title,
    providerId: job.providerId,
    model: job.model,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

const readAudioDuration = (file) => new Promise((resolve) => {
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
  audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
  audio.onerror = () => done(null);
  audio.src = url;
});

const inputClass = 'w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-port-accent focus:outline-none';
const labelClass = 'mb-1 block text-xs text-gray-400';
const fileInputClass = 'block w-full text-xs text-gray-400 file:mr-3 file:rounded file:border-0 file:bg-port-border file:px-3 file:py-1.5 file:text-gray-200';
const buttonPrimary = 'inline-flex items-center gap-2 rounded-lg bg-port-accent px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';
const buttonSecondary = 'inline-flex items-center gap-2 rounded-lg border border-port-border px-3 py-1.5 text-sm text-gray-200 hover:border-port-accent disabled:cursor-not-allowed disabled:opacity-40';
const providerFilter = (provider) => provider.enabled !== false;

// Read + upload one file; toasts and resolves null on failure.
async function uploadOrToast(file) {
  const base64 = await readFileAsBase64(file).catch(() => null);
  if (!base64) {
    toast.error(`Failed to read ${file.name}`);
    return null;
  }
  return uploadFile(base64, file.name, { silent: true }).catch((error) => {
    toast.error(error.message || `Failed to upload ${file.name}`);
    return null;
  });
}

export default function CodeAnimation() {
  const [searchParams] = useSearchParams();
  const routeParams = useParams();
  const navigate = useNavigate();
  const jobId = routeParams.jobId || searchParams.get('job') || '';
  const [options, setOptions] = useState(null);
  const [universes, setUniverses] = useState([]);
  const [universeStyles, setUniverseStyles] = useState({});
  const [boards, setBoards] = useState([]);
  const [libraryTracks, setLibraryTracks] = useState([]);
  const [trackPickerOpen, setTrackPickerOpen] = useState(false);
  const [draft, setDraft] = useState(loadDraft);
  const [uploading, setUploading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [writingBrief, setWritingBrief] = useState(false);
  // The last built prompt, tagged with the brief it was built from.
  const [built, setBuilt] = useState(null);
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState(null);
  const [galleryCounts, setGalleryCounts] = useState({ running: 0, completed: 0 });
  const [effort, setEffort] = useState('');
  const [briefEffort, setBriefEffort] = useState('');
  const [pastedHtml, setPastedHtml] = useState('');
  const [preview, setPreview] = useState(null);
  const hydratedJobIdRef = useRef('');
  const locallyStartedJobIdRef = useRef('');
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
  } = useProviderModels({ filter: providerFilter, silent: true, withEffort: true });
  const {
    providers: briefProviders,
    selectedProviderId: briefProviderId,
    selectedModel: briefModel,
    availableModels: briefModels,
    setSelectedProviderId: setBriefProviderId,
    setSelectedModel: setBriefModel,
    loading: briefProvidersLoading,
  } = useProviderModels({ filter: providerFilter, silent: true, withEffort: true });

  const update = (patch) => setDraft((prev) => ({ ...prev, ...patch }));
  const updateFormat = (patch) => setDraft((prev) => ({ ...prev, format: { ...prev.format, ...patch } }));

  const fetchGalleryPage = useCallback(async ({ cursor, signal }) => {
    const page = await listCodeAnimationJobPage({ cursor, signal });
    if (!signal.aborted) setGalleryCounts(page.counts);
    return page;
  }, []);
  const gallery = usePagedCollection(fetchGalleryPage);
  const savedJobs = gallery.items;
  const setSavedJobs = gallery.setItems;
  useSocketSubscription('code-animation', { onResubscribe: gallery.refreshFirst });
  useEffect(() => {
    const refresh = () => gallery.refreshFirst();
    socket.on('code-animation:changed', refresh);
    return () => socket.off('code-animation:changed', refresh);
  }, [gallery.refreshFirst]);

  useEffect(() => { safeWriteJsonStorage(DRAFT_KEY, draft); }, [draft]);

  useEffect(() => {
    getCodeAnimationOptions({ silent: true }).then(setOptions).catch(() => toast.error('Failed to load Code Animation options'));
    listUniverseNames({ silent: true }).then((rows) => setUniverses(Array.isArray(rows) ? rows : [])).catch(() => {});
    listUniverseStyles({ silent: true })
      .then((rows) => setUniverseStyles(Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [row.id, row]))))
      .catch(() => {});
    listMoodBoardNames({ silent: true }).then((rows) => setBoards(Array.isArray(rows) ? rows : [])).catch(() => {});
    listTracks({ silent: true })
      .then((rows) => setLibraryTracks(Array.isArray(rows) ? rows : rows?.tracks || []))
      .catch(() => {});
  }, []);

  const brief = useMemo(() => toBrief(draft), [draft]);
  const briefKey = useMemo(() => JSON.stringify(brief), [brief]);
  const promptStale = !!built && built.briefKey !== briefKey;
  const activeStyle = draft.universeId ? universeStyles[draft.universeId] : null;
  const limits = options?.limits;
  const maxRefs = limits?.referenceImagesMax ?? 8;
  const audioAccept = (options?.audioExtensions || ['mp3', 'wav', 'ogg', 'm4a']).map((ext) => `.${ext}`).join(',');
  const generating = job?.id === jobId && job.status === 'running';
  const canBuild = draft.concept.trim().length > 0 && !building && !uploading;
  // The writer needs a world or some words to be faithful to — it is not a
  // blank-slate idea generator.
  const briefSeeds = !!(draft.universeId || draft.seedIdea.trim() || draft.concept.trim() || draft.title.trim());
  const canWriteBrief = briefSeeds && !writingBrief;
  const inProgressCount = galleryCounts.running;
  const completedCount = galleryCounts.completed;

  // Clear route-specific output before applying the newly selected resource.
  useEffect(() => {
    hydratedJobIdRef.current = '';
    setJob(null);
    setPreview(null);
    setBuilt(null);
  }, [jobId]);
  const jobResource = useSocketResource(async () => {
    if (!jobId) return null;
    // Only a 404 means the job is gone. Transient failures retain the current
    // output and recover on the next event, reconnect or tab re-show.
    return getCodeAnimationJob(jobId, { silent: true }).catch((error) => {
      if (error.status === 404) return { id: jobId, status: 'missing', error: error.message };
      throw error;
    });
  }, {
    namespace: 'code-animation',
    events: JOB_EVENTS,
    resourceKey: jobId,
    matchesEvent: (payload) => !!jobId && payload?.id === jobId,
  });

  useEffect(() => {
    const next = jobResource.data;
    if (!next) return;
    const requested = jobId;
    setJob(next);
    if (next.status === 'completed' && next.html) setPreview({ html: next.html, audioUrl: next.audioUrl, frame: next.frame });
    else setPreview(null);
    if (next.status !== 'missing') {
      setSavedJobs((previous) => [galleryJob(next), ...previous.filter((item) => item.id !== requested)]
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
    }
    if (locallyStartedJobIdRef.current !== requested
      && hydratedJobIdRef.current !== requested
      && next.input) {
      hydratedJobIdRef.current = requested;
      const restoredDraft = draftFromJob(next);
      setDraft(restoredDraft);
      setSelectedProviderId(next.input.providerId || '');
      setSelectedModel(next.input.model || '');
      setEffort(next.input.effort || '');
      setBuilt(next.prompt ? {
        prompt: next.prompt,
        attachments: next.attachments || [],
        frame: next.frame,
        audioUrl: next.audioUrl,
        moodBoardId: next.moodBoardId,
        briefKey: JSON.stringify(toBrief(restoredDraft)),
      } : null);
    }
  }, [jobId, jobResource.data]);

  const handleImages = async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length) return;
    const room = Math.max(0, maxRefs - draft.referenceImages.length);
    if (files.length > room) toast.error(`Only ${room} more reference image(s) fit`);
    const valid = files.slice(0, room).filter((file) => {
      const invalid = validateImageFile(file);
      if (invalid) toast.error(invalid);
      return !invalid;
    });
    setUploading(true);
    const uploaded = await Promise.all(valid.map(async (file) => {
      const saved = await uploadOrToast(file);
      return saved ? { filename: saved.filename, label: file.name, note: '', url: saved.path } : null;
    }));
    const added = uploaded.filter(Boolean);
    setUploading(false);
    if (added.length) setDraft((prev) => ({ ...prev, referenceImages: [...prev.referenceImages, ...added] }));
  };

  const updateReference = (filename, patch) => setDraft((prev) => ({
    ...prev,
    referenceImages: prev.referenceImages.map((ref) => (ref.filename === filename ? { ...ref, ...patch } : ref)),
  }));

  const playableTracks = useMemo(() => libraryTracks.filter((t) => Boolean(t.audioFilename)), [libraryTracks]);

  const handlePickTrack = (track) => {
    if (!track) return;
    update({
      audio: {
        source: 'track',
        trackId: track.id,
        label: track.title || 'Untitled track',
        durationSeconds: track.durationSec ?? null,
        notes: '',
        url: track.audioFilename ? `/data/music/${encodeURIComponent(track.audioFilename)}` : '',
      },
    });
  };

  const handleAudio = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    const [durationSeconds, saved] = await Promise.all([readAudioDuration(file), uploadOrToast(file)]);
    setUploading(false);
    if (saved) update({ audio: { source: 'upload', filename: saved.filename, label: file.name, durationSeconds, notes: '', url: saved.path } });
  };

  // Ask a model to write the brief from the universe's bible and canon cast,
  // the way a series or story is generated from a universe. The result lands in
  // the form as an editable draft — nothing is generated from it until the user
  // builds the prompt.
  const handleWriteBrief = async () => {
    if (!canWriteBrief) return;
    const ideaInput = toBriefIdeaInput(draft);
    const startingBrief = ideaInput.current;
    setWritingBrief(true);
    const result = await generateCodeAnimationBrief({
      ...ideaInput,
      providerId: briefProviderId || undefined,
      model: briefModel || undefined,
      effort: briefEffort || undefined,
    }, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to write the brief');
      return null;
    });
    setWritingBrief(false);
    if (!result?.brief) return;
    // Fill only the fields the artist left untouched while the writer ran.
    setDraft((previous) => {
      const next = { ...previous };
      for (const [key, before] of Object.entries(startingBrief)) {
        const written = result.brief[key];
        if (typeof written !== 'string' || previous[key] !== before) continue;
        // A blank refinement or character bible means the writer had nothing to
        // add — never let it wipe what the artist already wrote there.
        if (KEEP_ON_BLANK.has(key) && !written) continue;
        next[key] = written;
      }
      return next;
    });
    toast.success('Brief written — edit it before building the prompt');
  };

  const handleBuild = async () => {
    if (!canBuild) return;
    setBuilding(true);
    const result = await buildCodeAnimationPrompt(brief, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to build the prompt');
      return null;
    });
    setBuilding(false);
    if (result) setBuilt({ ...result, briefKey });
  };

  const handleGenerate = async () => {
    if (!canBuild || !selectedProviderId || starting) return;
    setStarting(true);
    const started = await startCodeAnimationGeneration({
      ...brief,
      seedIdea: draft.seedIdea,
      providerId: selectedProviderId,
      model: selectedModel || undefined,
      effort: effort || undefined,
    }, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to start generation');
      return null;
    });
    setStarting(false);
    if (!started) return;
    locallyStartedJobIdRef.current = started.id;
    setBuilt({ prompt: started.prompt, attachments: started.attachments, frame: started.frame, audioUrl: started.audioUrl, moodBoardId: started.moodBoardId, briefKey });
    setJob(started);
    setPreview(null);
    setSavedJobs((previous) => [galleryJob(started), ...previous.filter((item) => item.id !== started.id)]);
    navigate(`/code-animation/${encodeURIComponent(started.id)}`);
  };

  const handlePreviewPasted = () => {
    if (!pastedHtml.trim()) return;
    setPreview({ html: pastedHtml, audioUrl: built?.audioUrl ?? draft.audio?.url ?? null, frame: built?.frame ?? null });
  };

  const boardName = (id) => boards.find((board) => board.id === id)?.name || 'linked board';

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        icon={FileCode2}
        title="Code Animation"
        subtitle="Prompt an LLM to code an animated film, with no assets, in a universe's style, then preview it and record it to video."
        className="rounded-xl border border-port-border bg-port-card"
      />

      <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-gallery-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="ca-gallery-heading" className="text-sm font-semibold text-white">Animation gallery</h2>
            <p className="mt-1 text-xs text-gray-500">
              {formatCount(inProgressCount)} in progress · {formatCount(completedCount)} completed
            </p>
          </div>
          <Link to="/code-animation" className={buttonSecondary}>
            <Sparkles className="h-4 w-4" /> New animation
          </Link>
        </div>
        {!gallery.loaded && <p className="text-xs text-gray-500">Loading animations…</p>}
        {gallery.loaded && savedJobs.length === 0 && !gallery.error && (
          <p className="text-xs text-gray-500">Generated animations will appear here so you can reopen them later.</p>
        )}
        {savedJobs.length > 0 && (
          <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
            {savedJobs.map((item) => {
              const StatusIcon = item.status === 'running'
                ? Clock3
                : item.status === 'completed'
                  ? CheckCircle2
                  : AlertTriangle;
              const statusLabel = item.status === 'running'
                ? 'In progress'
                : item.status === 'completed'
                  ? 'Completed'
                  : 'Failed';
              return (
                <Link
                  key={item.id}
                  to={`/code-animation/${encodeURIComponent(item.id)}`}
                  aria-current={jobId === item.id ? 'page' : undefined}
                  className={`min-w-0 rounded-lg border p-3 transition-colors hover:border-port-accent ${jobId === item.id ? 'border-port-accent bg-port-accent/10' : 'border-port-border bg-port-bg/60'}`}
                >
                  <div className="flex items-center gap-2">
                    <StatusIcon className={`h-4 w-4 shrink-0 ${item.status === 'failed' ? 'text-port-error' : item.status === 'completed' ? 'text-port-success' : 'text-port-accent'}`} />
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-white">{item.title || 'Untitled animation'}</p>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-500">
                    <span>{statusLabel}{item.model ? ` · ${item.model}` : ''}</span>
                    <span className="shrink-0">{timeAgo(item.createdAt)}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
        <InfiniteScrollFooter hasMore={gallery.hasMore} loading={gallery.loading} error={gallery.error}
          onLoadMore={gallery.loadMore} autoLoad={false} label="Load older animations" />
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-style-heading">
            <h2 id="ca-style-heading" className="flex items-center gap-2 text-sm font-semibold text-white"><Globe className="h-4 w-4 text-port-accent" /> Style</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="ca-universe" className={labelClass}>Universe (sets the art style)</label>
                <select id="ca-universe" value={draft.universeId} onChange={(event) => update({ universeId: event.target.value })} className={inputClass}>
                  <option value="">No universe</option>
                  {universes.map((universe) => <option key={universe.id} value={universe.id}>{universe.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="ca-board" className={labelClass}>Mood board</label>
                <select id="ca-board" value={draft.moodBoardChoice} onChange={(event) => update({ moodBoardChoice: event.target.value })} className={inputClass}>
                  <option value={BOARD_FOLLOW_UNIVERSE}>Universe&apos;s linked board</option>
                  <option value={BOARD_NONE}>No mood board</option>
                  {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
                </select>
              </div>
            </div>
            {activeStyle && (activeStyle.influences?.embrace?.length > 0 || activeStyle.influences?.avoid?.length > 0) && (
              <div className="flex flex-wrap gap-1 text-[11px]">
                {(activeStyle.influences.embrace || []).slice(0, 12).map((token) => (
                  <span key={`e-${token}`} className="rounded bg-port-accent/15 px-1.5 py-0.5 text-port-accent">{token}</span>
                ))}
                {(activeStyle.influences.avoid || []).slice(0, 6).map((token) => (
                  <span key={`a-${token}`} className="rounded bg-port-error/15 px-1.5 py-0.5 text-port-error line-through">{token}</span>
                ))}
              </div>
            )}
            {draft.universeId && !activeStyle && (
              <p className="text-xs text-gray-500">
                This universe has no style tokens yet, so only its notes and style references will be used. <Link to={`/universes/${encodeURIComponent(draft.universeId)}`} className="text-port-accent hover:underline">Edit its style guide</Link>
              </p>
            )}
            <div>
              <label htmlFor="ca-style-notes" className={labelClass}>Style refinements <span className="text-gray-600">(optional, applied on top of the universe style)</span></label>
              <textarea id="ca-style-notes" rows={2} value={draft.styleNotes} maxLength={limits?.styleNotesMax} onChange={(event) => update({ styleNotes: event.target.value })} placeholder="Heavier film grain, slower camera, dusk palette" className={`${inputClass} resize-y`} />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-300">
              <input type="checkbox" checked={draft.includeMoodBoardImages} onChange={(event) => update({ includeMoodBoardImages: event.target.checked })} />
              Attach mood board images as references
            </label>
          </section>

          <section className="rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-format-heading">
            <h2 id="ca-format-heading" className="mb-3 text-sm font-semibold text-white">Format</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="ca-duration" className={labelClass}>Duration (s)</label>
                <input id="ca-duration" type="number" min={limits?.durationMin ?? 3} max={limits?.durationMax ?? 180} value={draft.format.durationSeconds} onChange={(event) => updateFormat({ durationSeconds: Math.round(Number(event.target.value) || 0) })} className={inputClass} />
              </div>
              <div>
                <label htmlFor="ca-aspect" className={labelClass}>Aspect</label>
                <select id="ca-aspect" value={draft.format.aspectRatio} onChange={(event) => updateFormat({ aspectRatio: event.target.value })} className={inputClass}>
                  {(options?.aspectRatios || ['16:9']).map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="ca-resolution" className={labelClass}>Resolution</label>
                <select id="ca-resolution" value={draft.format.resolution} onChange={(event) => updateFormat({ resolution: event.target.value })} className={inputClass}>
                  {(options?.resolutions || ['1080p']).map((res) => <option key={res} value={res}>{res}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="ca-fps" className={labelClass}>FPS</label>
                <select id="ca-fps" value={draft.format.fps} onChange={(event) => updateFormat({ fps: Number(event.target.value) })} className={inputClass}>
                  {(limits?.fpsOptions || [30]).map((fps) => <option key={fps} value={fps}>{fps}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="ca-renderer" className={labelClass}>Renderer</label>
                <select id="ca-renderer" value={draft.renderer} onChange={(event) => update({ renderer: event.target.value })} className={inputClass}>
                  {(options?.renderers || ['auto']).map((renderer) => <option key={renderer} value={renderer}>{renderer}</option>)}
                </select>
              </div>
              <label className="flex items-end gap-2 pb-2 text-xs text-gray-300">
                <input type="checkbox" checked={draft.interactive} onChange={(event) => update({ interactive: event.target.checked })} />
                Interactive
              </label>
            </div>
          </section>

          <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-brief-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="ca-brief-heading" className="flex items-center gap-2 text-sm font-semibold text-white"><Sparkles className="h-4 w-4 text-port-accent" /> Brief</h2>
              <button type="button" onClick={handleWriteBrief} disabled={!canWriteBrief} className={buttonSecondary} title={briefSeeds ? undefined : 'Pick a universe or write a starting idea first'}>
                {writingBrief ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" />}
                Write brief
              </button>
            </div>
            <ProviderModelSelector
              providers={briefProviders}
              selectedProviderId={briefProviderId}
              selectedModel={briefModel}
              availableModels={briefModels}
              onProviderChange={(id) => { setBriefProviderId(id); setBriefEffort(''); }}
              onModelChange={setBriefModel}
              effort={briefEffort}
              onEffortChange={setBriefEffort}
              disabled={briefProvidersLoading || writingBrief}
              alwaysShowModel
              emptyModelOption="Provider default"
              label="Brief writing provider"
            />
            <div>
              <label htmlFor="ca-seed" className={labelClass}>
                Starting idea <span className="text-gray-600">(optional; what the brief writer starts from)</span>
              </label>
              <textarea id="ca-seed" rows={2} value={draft.seedIdea} maxLength={limits?.seedIdeaMax} onChange={(event) => update({ seedIdea: event.target.value })} placeholder="A chase through the lower market that ends in silence" className={`${inputClass} resize-y`} />
              <p className="mt-1 text-xs text-gray-500">
                {draft.universeId
                  ? 'Write brief casts the film from this universe\u2019s characters, places, and tone.'
                  : 'Pick a universe above to have the brief cast from its characters and places.'}
              </p>
            </div>
            <div>
              <label htmlFor="ca-title" className={labelClass}>Title <span className="text-gray-600">(optional)</span></label>
              <input id="ca-title" value={draft.title} maxLength={200} onChange={(event) => update({ title: event.target.value })} placeholder="The Lantern Keeper" className={inputClass} />
            </div>
            <div>
              <label htmlFor="ca-concept" className={labelClass}>What happens</label>
              <textarea id="ca-concept" rows={6} value={draft.concept} maxLength={limits?.conceptMax} onChange={(event) => update({ concept: event.target.value })} placeholder={'A paper lantern drifts over a sleeping harbor town, gathers fireflies, and bursts into a constellation.\n0:00–0:04 Low tracking shot: the lantern bobs past rooftops, curious…'} className={`${inputClass} resize-y`} />
            </div>
            <div>
              <label htmlFor="ca-cast" className={labelClass}>Characters <span className="text-gray-600">(optional; design bible the animation rigs)</span></label>
              <textarea id="ca-cast" rows={4} value={draft.cast} maxLength={limits?.castMax} onChange={(event) => update({ cast: event.target.value })} placeholder="Wick — a palm-sized paper lantern: round body, bent-wire handle that droops when sad; palette cream #F3E6C4, ember #E8763A; face: two ink-dot eyes (curious, sleepy, startled, delighted, determined). Identity lock: silhouette and handle never change." className={`${inputClass} resize-y`} />
            </div>
            <div>
              <label htmlFor="ca-text" className={labelClass}>On-screen text / narration <span className="text-gray-600">(optional)</span></label>
              <textarea id="ca-text" rows={2} value={draft.onScreenText} maxLength={limits?.textMax} onChange={(event) => update({ onScreenText: event.target.value })} placeholder={'0:02 "Every night, one light remains"\n0:15 Title card'} className={`${inputClass} resize-y`} />
            </div>
          </section>

          <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-refs-heading">
            <h2 id="ca-refs-heading" className="flex items-center gap-2 text-sm font-semibold text-white"><ImagePlus className="h-4 w-4 text-port-accent" /> References &amp; audio</h2>
            <div>
              <label htmlFor="ca-images" className={labelClass}>Reference images ({draft.referenceImages.length}/{maxRefs})</label>
              <input id="ca-images" type="file" multiple accept={UPLOAD_IMAGE_ACCEPT} onChange={handleImages} disabled={uploading} className={fileInputClass} />
              {draft.referenceImages.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {draft.referenceImages.map((ref) => (
                    <li key={ref.filename} className="flex items-center gap-2">
                      <img src={ref.url} alt={ref.label} className="h-12 w-12 shrink-0 rounded object-cover" />
                      <input aria-label={`Note for ${ref.label}`} value={ref.note} maxLength={limits?.referenceNoteMax} onChange={(event) => updateReference(ref.filename, { note: event.target.value })} placeholder="What to take from it (palette, silhouette…)" className={`${inputClass} min-w-0`} />
                      <button type="button" aria-label={`Remove ${ref.label}`} onClick={() => update({ referenceImages: draft.referenceImages.filter((item) => item.filename !== ref.filename) })} className="shrink-0 text-gray-500 hover:text-port-error"><X className="h-4 w-4" /></button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <label htmlFor="ca-audio" className={`${labelClass} flex items-center gap-1`}><Music2 className="h-3 w-3" /> Audio track <span className="text-gray-600">(optional; the animation syncs to it)</span></label>
              {draft.audio ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-gray-200">
                    <span className="min-w-0 truncate">{draft.audio.label}</span>
                    {draft.audio.durationSeconds ? <span className="text-xs text-gray-500">{draft.audio.durationSeconds.toFixed(1)}s</span> : null}
                    <span className="rounded bg-port-card-hover px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-gray-400">
                      {draft.audio.source === 'track' ? 'Library track' : 'Upload'}
                    </span>
                    <button type="button" aria-label="Remove audio track" onClick={() => update({ audio: null })} className="ml-auto text-gray-500 hover:text-port-error"><X className="h-4 w-4" /></button>
                  </div>
                  <textarea aria-label="Audio notes" rows={2} value={draft.audio.notes} maxLength={limits?.audioNotesMax} onChange={(event) => update({ audio: { ...draft.audio, notes: event.target.value } })} placeholder="120 BPM; soft intro, drop at 0:16, fade at 0:40" className={`${inputClass} resize-y`} />
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input id="ca-audio" type="file" accept={audioAccept} onChange={handleAudio} disabled={uploading} className={`${fileInputClass} flex-1 min-w-[200px]`} />
                    <button
                      type="button"
                      onClick={() => setTrackPickerOpen(true)}
                      className={buttonSecondary}
                    >
                      <Music2 className="h-3.5 w-3.5" /> Pick from music library
                    </button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-300">
                    <input type="checkbox" checked={draft.soundtrack === 'procedural'} onChange={(event) => update({ soundtrack: event.target.checked ? 'procedural' : 'none' })} />
                    No track? Have the code compose a procedural soundtrack
                  </label>
                </div>
              )}
            </div>
            {uploading && <p className="flex items-center gap-2 text-xs text-gray-400"><LoaderCircle className="h-3 w-3 animate-spin" /> Uploading…</p>}
          </section>

        </div>

        <div className="space-y-4">
          <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-prompt-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="ca-prompt-heading" className="text-sm font-semibold text-white">Prompt</h2>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={handleBuild} disabled={!canBuild} className={buttonPrimary}>
                  {building ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  {built ? 'Rebuild prompt' : 'Build prompt'}
                </button>
                <button type="button" onClick={() => built && copyToClipboard(built.prompt, 'Prompt copied')} disabled={!built} className={buttonSecondary}>
                  <Copy className="h-4 w-4" /> Copy
                </button>
              </div>
            </div>
            {!draft.concept.trim() && <p className="text-xs text-gray-500">Describe what happens in the brief to build a prompt.</p>}
            {built && (
              <>
                {promptStale && <p className="text-xs text-port-warning">The brief changed since this prompt was built. Rebuild to include your edits.</p>}
                {built.moodBoardId && draft.moodBoardChoice === BOARD_FOLLOW_UNIVERSE && (
                  <p className="text-xs text-gray-500">Using the universe&apos;s mood board: {boardName(built.moodBoardId)}</p>
                )}
                <textarea readOnly aria-label="Generated prompt" value={built.prompt} rows={14} className={`${inputClass} font-mono text-xs`} />
                {built.attachments?.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs text-gray-400">Attach these images, in order, when you paste the prompt into another LLM:</p>
                    <div className="flex flex-wrap gap-2">
                      {built.attachments.map((attachment, index) => (
                        <a key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer" title={`${index + 1}. ${attachment.label} (${attachment.origin})`} className="relative block h-14 w-14 overflow-hidden rounded border border-port-border">
                          <img src={attachment.url} alt={attachment.label} className="h-full w-full object-cover" />
                          <span className="port-media-overlay-strong absolute left-0 top-0 rounded-br px-1 text-[10px]">{index + 1}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-generate-heading">
            <h2 id="ca-generate-heading" className="text-sm font-semibold text-white">Generate &amp; preview</h2>
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onProviderChange={(id) => { setSelectedProviderId(id); setEffort(''); }}
              onModelChange={setSelectedModel}
              effort={effort}
              onEffortChange={setEffort}
              disabled={providersLoading || starting}
              alwaysShowModel
              emptyModelOption="Provider default"
              label="Generation provider"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={handleGenerate} disabled={!canBuild || !selectedProviderId || starting || generating} className={buttonPrimary}>
                {starting || generating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {generating ? 'Generating…' : 'Generate animation'}
              </button>
              {job?.status === 'failed' && <span className="text-xs text-port-error">Generation failed: {job.error}</span>}
              {job?.status === 'missing' && <span className="text-xs text-gray-500">That generation is no longer available.</span>}
            </div>
            <details className="text-xs text-gray-400">
              <summary className="cursor-pointer select-none">Preview HTML from another LLM</summary>
              <div className="mt-2 space-y-2">
                <textarea aria-label="Pasted animation HTML" rows={4} value={pastedHtml} onChange={(event) => setPastedHtml(event.target.value)} placeholder="Paste the <!DOCTYPE html> document the model returned" className={`${inputClass} font-mono text-xs`} />
                <button type="button" onClick={handlePreviewPasted} disabled={!pastedHtml.trim()} className={buttonSecondary}>Preview pasted HTML</button>
              </div>
            </details>
            {preview && options && (
              <CodeAnimationPreview
                html={preview.html}
                audioUrl={preview.audioUrl}
                frame={preview.frame}
                messages={options.messages}
                audioGlobal={options.audioGlobal}
                title={draft.title || draft.concept.slice(0, 40)}
              />
            )}
          </section>
        </div>
      </div>
      <AlbumTrackPicker
        open={trackPickerOpen}
        tracks={playableTracks}
        onClose={() => setTrackPickerOpen(false)}
        onAdd={([selected]) => {
          if (selected) handlePickTrack(selected);
        }}
        single
        title="Pick soundtrack track"
      />
    </div>
  );
}
