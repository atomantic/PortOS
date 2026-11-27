import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import useProviderModels from '../../hooks/useProviderModels';
import { useSocketResource } from '../../hooks/useSocketResource';
import toast from '../ui/Toast';
import { buildCodeAnimationPrompt, cancelCodeAnimationGeneration, generateCodeAnimationBrief, getCodeAnimationJob, getCodeAnimationOptions, startCodeAnimationGeneration } from '../../services/apiCodeAnimation.js';
import useMounted from '../../hooks/useMounted';
import { listTracks } from '../../services/apiTracks.js';
import { uploadFile } from '../../services/apiMedia.js';
import { uuidv4 } from '../../lib/uuid';
import { pluralize } from '../../lib/textUtils';
import { safeWriteJsonStorage } from '../../lib/safeStorage';
import { validateImageFile } from '../../utils/fileUpload';
import { DRAFT_KEY, KEEP_ON_BLANK, loadDraft, toBrief, toBriefIdeaInput, draftFromJob } from './codeAnimationDraft';

const JOB_EVENTS = ['code-animation:changed'];
const providerFilter = (provider) => provider.enabled !== false;

const readAudioDuration = (file) => new Promise((resolve) => {
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
  audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
  audio.onerror = () => done(null);
  audio.src = url;
});

// Read + upload one file; toasts and resolves null on failure.
async function uploadOrToast(file) {
  return uploadFile(file, file.name, { silent: true }).catch((error) => {
    toast.error(error.message || `Failed to upload ${file.name}`);
    return null;
  });
}

function useReferenceAssets({ draft, setDraft, update, options, limits }) {
  const [libraryTracks, setLibraryTracks] = useState([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    listTracks({ silent: true })
      .then((rows) => setLibraryTracks(Array.isArray(rows) ? rows : rows?.tracks || []))
      .catch(() => {});
  }, []);

  // A reference video is studied as a contact sheet plus keyframes, which
  // occupy reference-image slots.
  const maxRefs = (limits?.referenceImagesMax ?? 8) - (draft.referenceVideo ? limits?.referenceVideoImageSlots ?? 3 : 0);
  const videoRoom = (limits?.referenceImagesMax ?? 8) - draft.referenceImages.length >= (limits?.referenceVideoImageSlots ?? 3);
  const audioAccept = (options?.audioExtensions || ['mp3', 'wav', 'ogg', 'm4a']).map((ext) => `.${ext}`).join(',');

  const handleImages = async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length) return;
    const room = Math.max(0, maxRefs - draft.referenceImages.length);
    if (files.length > room) toast.error(`Only ${pluralize(room, 'more reference image')} fit`);
    const valid = files.slice(0, room).filter((file) => {
      const invalid = validateImageFile(file, Infinity);
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

  return {
    maxRefs, handleImages, uploading, updateReference, videoRoom, audioAccept, handleAudio,
    playableTracks, handlePickTrack,
  };
}

function useBriefWriter({ draft, setDraft }) {
  const [writingBrief, setWritingBrief] = useState(false);
  const [briefEffort, setBriefEffort] = useState('');
  const {
    providers: briefProviders,
    selectedProviderId: briefProviderId,
    selectedModel: briefModel,
    availableModels: briefModels,
    setSelectedProviderId: setBriefProviderId,
    setSelectedModel: setBriefModel,
    loading: briefProvidersLoading,
  } = useProviderModels({ filter: providerFilter, silent: true, withEffort: true });

  // The writer needs a world or some words to be faithful to — it is not a
  // blank-slate idea generator.
  const briefSeeds = !!(draft.universeId || draft.seedIdea.trim() || draft.concept.trim() || draft.title.trim());
  const canWriteBrief = briefSeeds && !writingBrief;

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

  return {
    handleWriteBrief, canWriteBrief, briefSeeds, writingBrief, briefProviders, briefProviderId,
    briefModel, briefModels, setBriefProviderId, setBriefEffort, setBriefModel, briefEffort,
    briefProvidersLoading,
  };
}

export default function useCodeAnimationRunner({ jobId, draftId }) {
  const navigate = useNavigate();
  const [options, setOptions] = useState(null);
  const draftKey = draftId ? `${DRAFT_KEY}.${draftId}` : DRAFT_KEY;
  const [loadedDraftKey, setLoadedDraftKey] = useState(draftKey);
  const [draft, setDraft] = useState(() => loadDraft(draftKey));
  // Restore a different draft before rendering or persisting its form.
  if (loadedDraftKey !== draftKey) {
    setLoadedDraftKey(draftKey);
    if (draftId) setDraft(loadDraft(draftKey));
  }
  const [building, setBuilding] = useState(false);
  // The last built prompt, tagged with the brief it was built from.
  const [built, setBuilt] = useState(null);
  const [starting, setStarting] = useState(false);
  const [cancelingJobId, setCancelingJobId] = useState('');
  const [job, setJob] = useState(null);
  const [effort, setEffort] = useState('');
  const [pastedHtml, setPastedHtml] = useState('');
  const [preview, setPreview] = useState(null);
  const mounted = useMounted();
  const currentJobIdRef = useRef(jobId);
  currentJobIdRef.current = jobId;
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

  const update = (patch) => setDraft((prev) => ({ ...prev, ...patch }));
  const onStyleGrammarChange = useCallback((styleGrammarId) => setDraft((prev) => ({ ...prev, styleGrammarId })), []);
  const updateFormat = (patch) => setDraft((prev) => ({ ...prev, format: { ...prev.format, ...patch } }));

  useEffect(() => {
    if (draftId) safeWriteJsonStorage(draftKey, draft);
  }, [draft, draftKey, draftId]);

  useEffect(() => {
    getCodeAnimationOptions({ silent: true }).then(setOptions).catch(() => toast.error('Failed to load Code Animation options'));
  }, []);

  const brief = useMemo(() => toBrief(draft), [draft]);
  const briefKey = useMemo(() => JSON.stringify(brief), [brief]);
  const promptStale = !!built && built.briefKey !== briefKey;
  const limits = options?.limits;
  const assets = useReferenceAssets({ draft, setDraft, update, options, limits });
  const writer = useBriefWriter({ draft, setDraft });
  const generating = job?.id === jobId && job.status === 'running';
  const canceling = !!jobId && cancelingJobId === jobId;
  const canBuild = draft.concept.trim().length > 0 && !building && !assets.uploading;

  // Clear route-specific output before applying the newly selected resource.
  useEffect(() => {
    hydratedJobIdRef.current = '';
    setJob(null);
    setPreview(null);
    setBuilt(null);
  }, [jobId, draftId]);
  const jobResource = useSocketResource(async () => {
    if (!jobId) return null;
    // Only a 404 means the job is gone. Transient failures retain the current
    // output and offer retry, with recovery on events, reconnect or tab re-show.
    return getCodeAnimationJob(jobId, { silent: true }).catch((error) => {
      if (error.status === 404) return { id: jobId, status: 'missing', error: error.message };
      throw error;
    });
  }, {
    namespace: 'code-animation',
    events: JOB_EVENTS,
    resourceKey: jobId,
    // A poster event changes only the gallery; re-reading the job would hand the
    // preview a new frame object and restart a session the user is watching.
    matchesEvent: (payload) => !!jobId && payload?.id === jobId && payload.kind !== 'poster',
  });

  useEffect(() => {
    const next = jobResource.data;
    if (!next) return;
    const requested = jobId;
    setJob(next);
    // Keep the same preview object when only other job fields changed (a
    // soundtrack request), so the running preview session is not restarted.
    if (next.status === 'completed' && next.html) {
      setPreview((current) => (current?.jobId === next.id && current.html === next.html && current.audioUrl === next.audioUrl
        ? current
        : { html: next.html, audioUrl: next.audioUrl, frame: next.frame, jobId: next.id }));
    } else setPreview(null);
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
    navigate(`/code-animation/${encodeURIComponent(started.id)}`);
  };

  const handleCancel = async () => {
    if (!generating || canceling) return;
    const targetId = job.id;
    setCancelingJobId(targetId);
    const updated = await cancelCodeAnimationGeneration(targetId, { silent: true }).catch((error) => {
      toast.error(error.message || 'Could not cancel generation');
      return null;
    });
    if (!mounted.current) return;
    setCancelingJobId((current) => (current === targetId ? '' : current));
    if (!updated) return;
    if (currentJobIdRef.current === targetId) setJob(updated);
    toast.success('Generation canceled');
  };

  // Fork a finished animation: keep its brief, extend its code. The new run is
  // a separate job, so leave the job route; the draft carries everything.
  const handleFork = () => {
    if (!job || job.status !== 'completed') return;
    const forked = draftFromJob(job);
    // A soundtrack generated at the old length would not fit the longer cut.
    const audio = forked.audio?.trackId && forked.audio.trackId === job.soundtrack?.trackId ? null : forked.audio;
    const id = uuidv4();
    safeWriteJsonStorage(`${DRAFT_KEY}.${id}`, { ...forked, audio, base: { jobId: job.id, title: job.title || '', durationSeconds: job.frame?.durationSeconds ?? null } });
    navigate(`/code-animation/drafts/${id}`);
    toast.success('Forked. Set the new duration and write what happens next, then Generate animation.');
  };

  const handlePreviewPasted = () => {
    if (!pastedHtml.trim()) return;
    setPreview({ html: pastedHtml, audioUrl: built?.audioUrl ?? draft.audio?.url ?? null, frame: built?.frame ?? null });
  };


  return {
    draft, update, updateFormat, onStyleGrammarChange, options, limits, assets, writer,
    output: {
      handleBuild, canBuild, building, built, promptStale, providers, selectedProviderId,
      selectedModel, availableModels, setSelectedProviderId, setEffort, setSelectedModel, effort,
      providersLoading, starting, generating, handleGenerate, handleCancel, canceling, job,
      jobResource, pastedHtml, setPastedHtml, handlePreviewPasted, preview, handleFork,
    },
  };
}
