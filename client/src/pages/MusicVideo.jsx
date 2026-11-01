import ProductionReviewPanel from '../components/musicVideo/ProductionReviewPanel.jsx';
import { unfoldToAnchor } from '../lib/unfoldToAnchor.js';
import useMusicVideoProductionReview from '../hooks/useMusicVideoProductionReview.js';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router';
import { Plus, Film, Wand2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import PageHeader from '../components/PageHeader';
import Banner from '../components/ui/Banner.jsx';
import { usePagedCollection } from '../hooks/usePagedCollection';
import InfiniteScrollFooter from '../components/ui/InfiniteScrollFooter';
import {
  listMusicVideoProjectSummaries,
  createMusicVideoProject,
  cloneMusicVideoProject,
  updateMusicVideoProject,
  deleteMusicVideoProject,
  analyzeMusicVideoProject,
  prepareMusicVideoSong,
  planMusicVideoProject,
  addMusicVideoScene,
  updateMusicVideoScene,
  deleteMusicVideoScene,
  splitMusicVideoScene,
  mergeMusicVideoNextScene, mergeMusicVideoPreviousScene,
  moveMusicVideoSceneStart,
  reorderMusicVideoScenes,
  importMusicVideoLyrics,
  importMusicVideoTrackLyrics,
  refreshMusicVideoSongStyleFromSuno,
  getMusicVideoActiveJobs,
  getMusicVideoProject,
} from '../services/apiMusicVideo.js';
import useFieldDraft from '../hooks/useFieldDraft.js';
import useMusicVideoYoutubeImport from '../hooks/useMusicVideoYoutubeImport.js';
import useMusicVideoMidiJob from '../hooks/useMusicVideoMidiJob.js';
import useMusicVideoKickoff from '../hooks/useMusicVideoKickoff.js';
import useMusicVideoCastAndSets from '../hooks/useMusicVideoCastAndSets.js';
import useMusicVideoDevArtifacts from '../hooks/useMusicVideoDevArtifacts.js';
import useMusicVideoLyricAlign from '../hooks/useMusicVideoLyricAlign.js';
import useMusicVideoVocalSeparation from '../hooks/useMusicVideoVocalSeparation.js';
import useMusicVideoRenderJob from '../hooks/useMusicVideoRenderJob.js';
import useMusicVideoExcerpts from '../hooks/useMusicVideoExcerpts.js';
import useMusicVideoPublishKit from '../hooks/useMusicVideoPublishKit.js';
import useMusicVideoPublishing from '../hooks/useMusicVideoPublishing.js';
import useMusicVideoRevisions from '../hooks/useMusicVideoRevisions.js';
import useMusicVideoAutoReview from '../hooks/useMusicVideoAutoReview.js';
import useMusicVideoProduction from '../hooks/useMusicVideoProduction.js';
import useAutonomousMusicVideo from '../hooks/useAutonomousMusicVideo.js';
import useDrawerTab from '../hooks/useDrawerTab.js';
import useListResource from '../hooks/useListResource.js';
import useMusicVideoModelSettings from '../hooks/useMusicVideoModelSettings.js';
import useMusicVideoManualTempo from '../hooks/useMusicVideoManualTempo.js';
import useMusicVideoSceneMedia from '../hooks/useMusicVideoSceneMedia.js';
import useMusicVideoTakes from '../hooks/useMusicVideoTakes.js';
import useMusicVideoTreatment, { aiSkipLabel } from '../hooks/useMusicVideoTreatment.js';
import useHydratedPreviewRoute from '../hooks/useHydratedPreviewRoute.js';
import { normalizeImage, normalizeVideo } from '../components/media/normalize.js';
import { castAndSetsPreviewItems } from '../components/musicVideo/CastAndSetsReferenceProgress.jsx';
import { useVideoFileSrc } from '../hooks/useVideoFileSrc.js';
import MediaPreview from '../components/media/MediaPreview.jsx';
import MidiInstallModal from '../components/install/MidiInstallModal.jsx';
import MidiGatedModal from '../components/install/MidiGatedModal.jsx';
import { listTracks, trackAudioUrl } from '../services/apiTracks.js';
import CreateProjectDrawer from '../components/musicVideo/CreateProjectDrawer.jsx';
import AutonomousStartDrawer from '../components/musicVideo/AutonomousStartDrawer.jsx';
import { automationDraftFrom, automationFromDraft } from '../lib/musicVideoAutomation.js';
import { listUniverseNames } from '../services/apiUniverseBuilder.js';
import MusicVideoLayout, { MUSIC_VIDEO_PAGE_ID, MUSIC_VIDEO_SCROLL_ID } from '../components/musicVideo/MusicVideoLayout.jsx';
import ProjectManageActions from '../components/musicVideo/ProjectManageActions.jsx';
import ProjectSettingsDrawer, { SETTINGS_TAB_IDS } from '../components/musicVideo/ProjectSettingsDrawer.jsx';
import MusicVideoProjectCard from '../components/musicVideo/MusicVideoProjectCard.jsx';
import PreviewDock from '../components/musicVideo/PreviewDock.jsx';
import TitleCardPanel from '../components/musicVideo/TitleCardPanel.jsx';
import StatsOutroPanel from '../components/musicVideo/StatsOutroPanel.jsx';
import CreditsOutroPanel from '../components/musicVideo/CreditsOutroPanel.jsx';
import NeedsAttentionBanner from '../components/musicVideo/NeedsAttentionBanner.jsx';
import SetupStage from '../components/musicVideo/stages/SetupStage.jsx';
import StoryStage from '../components/musicVideo/stages/StoryStage.jsx';
import StageChecklist from '../components/musicVideo/StageChecklist.jsx';
import CastSetsStage from '../components/musicVideo/stages/CastSetsStage.jsx';
import PlanStage from '../components/musicVideo/stages/PlanStage.jsx';
import ProduceStage from '../components/musicVideo/stages/ProduceStage.jsx';
import ReviewStage from '../components/musicVideo/stages/ReviewStage.jsx';
import { PUBLISH_TARGETS } from '../components/musicVideo/PublishPostingPanel.jsx';
import PublishStage from '../components/musicVideo/stages/PublishStage.jsx';
import CleanupStage from '../components/musicVideo/stages/CleanupStage.jsx';
import AssetsStage from '../components/musicVideo/stages/AssetsStage.jsx';
import { compositionDraft } from '../components/musicVideo/compositionDraft.js';
import ContactSheetDrawer from '../components/musicVideo/ContactSheetDrawer.jsx';
import DevArtifactDrawer from '../components/musicVideo/DevArtifactDrawer.jsx';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker.jsx';
import GalleryVideoPicker from '../components/videoGen/GalleryVideoPicker.jsx';
import { autoArrangeScenes } from '../lib/beatGrid.js';
import { isLtx2FamilyRuntime } from '../lib/runnerFamilies';
import { videoPosterForJob } from '../lib/creativeDirectorPreview.js';
import { sceneTakeList } from '../lib/musicVideoTakes.js';
import { pluralize } from '../lib/textUtils.js';
import { formatCount, formatTimecode } from '../utils/formatters.js';
import { deriveAttentionItems } from '../lib/musicVideoAttention.js';
import { latestMusicVideoReviewDraft } from '../../../server/lib/musicVideoReviewDraft.js';
import { useMusicVideoReviewDraft } from '../hooks/useMusicVideoReviewDraft.js';
import {
  deriveNextAction, deriveStages, describeProjectStatus, listPreviewSources, projectSpend, resolveStageParam, stageChecklist, stepNotes, autopilotStatus, compareMusicVideoProjectsNewestFirst, proofReviewInUse,
} from '../lib/musicVideoStages.js';
import { groupMusicVideoProjects } from '../lib/musicVideoProjectList.js';
import { AUTONOMOUS_VIEWABLE_STAGES } from '../lib/musicVideoAutonomous.js';

// Automation first: a new project defaults to autopilot with the free tools.
const emptyCreateForm = () => ({
  name: '', mode: 'autonomous', trackId: '', characterStyleId: '', universeId: '', moodBoardId: '', automation: automationDraftFrom(null),
});

// Format project label for the header dropdown: omit trailing media type parentheticals
// like "(experimental, images)" or "(revision)" so the title remains clean.
function formatProjectPickerLabel(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/\s*\([^)]*\)$/, '').trim();
}

// Why the autopilot kickoff can't run yet, or null when it can.
function autopilotBlocker(project) {
  if (!project) return null;
  if (!project.trackId && !project.uploadedAudioFilename) return 'Attach a track before starting autopilot.';
  if ((project.scenes || []).length > 0) return 'The board already has shots — edit them below or fork a new version to re-plan.';
  return null;
}

// The panels each stage tab renders (see lib/musicVideoStages.js for the ids).
// A saved art draft needs every field the server schema requires.
const EMPTY_PRODUCTION_DRAFT = { cast: '', environments: '', visualLanguage: '', motionLanguage: '', guideArtifactId: null,
  lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [] };
// The step each production approval closes (#10151); it sits at the bottom of that step.
// Once the storyboard is approved, a production run parked on its pilot shows
// its optional animated proof there instead.
const APPROVAL_STAGE_BY_TAB = { 'cast-sets': 'art', produce: 'storyboard' };
const approvalStageFor = (tab, project, readiness, proofActive) => (tab === 'produce' && readiness?.storyboard?.approved
  ? (proofReviewInUse(project, readiness, { proofActive }) ? 'proof' : null)
  : APPROVAL_STAGE_BY_TAB[tab] || null);
// Steps reviewed by watching: the player leads them, with the approval beside it.
const PLAYER_FIRST_STAGES = new Set(['produce', 'review']);
// Steps with no player: Assets is a contact sheet, Story and Plan are read and edited rather than watched.
const NO_DOCK_STAGES = new Set(['assets', 'story', 'board']);
const STAGE_VIEWS = {
  setup: SetupStage, story: StoryStage, 'cast-sets': CastSetsStage, board: PlanStage, produce: ProduceStage, review: ReviewStage, publish: PublishStage,
  assets: AssetsStage, cleanup: CleanupStage,
};



// Stable fetcher for useListResource — the hook re-runs on identity change.
const loadTracks = () => listTracks({ silent: true });
const loadUniverses = () => listUniverseNames({ silent: true });

export default function MusicVideo() {
  // Deep-linkable project selection: the selected project lives in the URL
  // (/music-video/:projectId) rather than local state, so a project's
  // scene board is directly shareable/bookmarkable and reachable from the
  // media job-completion hooks. selectProject() navigates; the browser URL is
  // the single source of truth for "which project is open".
  // The open stage is `/music-video/:projectId/:stage` (Setup, Cast & Sets,
  // Board, Produce, Compose, Review); a missing or unknown stage opens the
  // stage the project was in. A development artifact opens from its own deep
  // link (/music-video/:projectId/:stage/dev/:artifactId, or the older
  // /music-video/:projectId/dev/:artifactId), the version from `?v=`.
  const { projectId: routeProjectId, artifactId: routeArtifactId, stage: routeStage, sceneId: routeSceneId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const newParam = searchParams.get('new');
  const createOpen = newParam === 'project';
  const autonomousOpen = newParam === 'autonomous';
  const setCreateOpen = (open) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (open) next.set('new', 'project'); else next.delete('new');
    return next;
  });
  const setAutonomousOpen = (open) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (open) next.set('new', 'autonomous'); else next.delete('new');
    return next;
  });
  const navigate = useNavigate();
  // The index and picker read bounded summaries; an open project is its own
  // single-record fetch (#10169), so neither load can fail the other.
  const [selectedProject, setSelectedProject] = useState(null);
  // The last failed/absent read of the open project, keyed by id so it never
  // outlives a navigation; it stays up during a retry and clears on success.
  const [selectedFault, setSelectedFault] = useState(null);
  const [selectedFetching, setSelectedFetching] = useState(false);
  const [selectedReload, setSelectedReload] = useState(0);
  // The id whose single-record fetch is in flight, so a patch that lands for
  // it mid-flight (a job finishing) can refetch instead of being folded into a
  // response that may predate it.
  const fetchingIdRef = useRef(null);
  // The music library the pickers read. A failed read is shown as such, with
  // Retry, never as an empty library; an import appends to it locally.
  const trackLibrary = useListResource(loadTracks);
  const { items: tracks, setItems: setTracks } = trackLibrary;
  // Imports can complete before the library read; replace that pre-import read.
  const onTrackImported = (track) => {
    if (trackLibrary.state !== 'ready') trackLibrary.retry();
    else setTracks((prev) => [...prev.filter((item) => item.id !== track.id), track]);
  };
  const universeResource = useListResource(loadUniverses);
  const universes = universeResource.items;
  // A project-less stage URL (/music-video/board, from the nav manifest) names a stage, not a project:
  // treat it as the index until the summaries resolve, then redirect to the newest project at that stage.
  const stageOnlyParam = !routeStage && !routeSceneId && !routeArtifactId ? resolveStageParam(routeProjectId) : null;
  const selectedId = stageOnlyParam ? null : (routeProjectId || null);
  // Summaries load for the index, or once the header picker is used on a deep link;
  // once wanted they stay loaded (disabling the hook would reset its items).
  const [summariesWanted, setSummariesWanted] = useState(!selectedId);
  if (!selectedId && !summariesWanted) setSummariesWanted(true);
  const fetchSummariesPage = useCallback(
    ({ cursor, signal }) => listMusicVideoProjectSummaries({ cursor, limit: 30 }, { signal, silent: true }),
    [],
  );
  const summaries = usePagedCollection(fetchSummariesPage, { enabled: summariesWanted });
  // Same stickiness for the list: the banner outlives the retry that clears `summaries.error`.
  const [listError, setListError] = useState(null);
  useEffect(() => {
    if (summaries.error) setListError(summaries.error.message || 'Failed to load music video projects');
    else if (summaries.loaded) setListError(null);
  }, [summaries.error, summaries.loaded]);
  const selectedLoaded = selectedProject?.id === selectedId;
  const fault = selectedFault?.id === selectedId ? selectedFault : null;
  const loading = selectedId ? !selectedLoaded && (selectedFetching || !fault) : (summaries.loading || !summaries.loaded) && !summaries.error;
  const projectsError = selectedId ? (fault?.notFound ? null : fault?.message) : listError;

  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    setSelectedFetching(true);
    fetchingIdRef.current = selectedId;
    getMusicVideoProject(selectedId, { silent: true })
      .then((project) => {
        if (cancelled) return;
        setSelectedFault(project ? null : { id: selectedId, notFound: true });
        if (project) setSelectedProject(project);
      })
      .catch((err) => {
        if (!cancelled) setSelectedFault({ id: selectedId, notFound: err?.status === 404, message: err?.message || 'Failed to load music video project' });
      })
      .finally(() => {
        if (cancelled) return;
        fetchingIdRef.current = null;
        setSelectedFetching(false);
      });
    return () => { cancelled = true; };
  }, [selectedId, selectedReload]);

  const loadProjects = selectedId
    ? () => setSelectedReload((n) => n + 1)
    : () => { if (!summaries.loading) summaries.refreshFirst(); };
  const selected = selectedLoaded ? selectedProject : null;

  const [analyzing, setAnalyzing] = useState(false);
  const [cloningId, setCloningId] = useState(null);
  const cloning = !!cloningId;
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyCreateForm);

  const handleRename = () => {
    if (!selected) return;
    setRenameDraft(selected.name || '');
    setRenamingId(selected.id);
  };
  const commitRename = () => {
    const name = renameDraft.trim();
    if (!selected || !name || name === selected.name) { setRenamingId(null); return; }
    const projectId = selected.id;
    updateMusicVideoProject(projectId, { name })
      .then((saved) => { patchProject(projectId, { name: saved?.name ?? name, updatedAt: saved?.updatedAt }); setRenamingId(null); })
      .catch(() => {});
  };
  // Holds the id being renamed so the form closes itself when another project opens.
  const [renamingId, setRenamingId] = useState(null);
  const renaming = !!selected && renamingId === selected.id;
  const [renameDraft, setRenameDraft] = useState('');
  const renameForm = renaming ? (
    <form
      onSubmit={(e) => { e.preventDefault(); commitRename(); }}
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      <label htmlFor="mv-rename-input" className="sr-only">Project title</label>
      <input
        id="mv-rename-input"
        autoFocus
        value={renameDraft}
        maxLength={120}
        onChange={(e) => setRenameDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setRenamingId(null); }}
        className="min-w-0 flex-1 basis-48 sm:max-w-md bg-port-bg border border-port-border rounded px-2 py-1.5 text-base sm:text-sm"
      />
      <button type="submit" disabled={!renameDraft.trim()} className="rounded bg-port-accent px-3 py-1.5 text-sm text-white disabled:opacity-50 min-h-[44px] sm:min-h-0">Save</button>
      <button type="button" onClick={() => setRenamingId(null)} className="rounded border border-port-border px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0">Cancel</button>
    </form>
  ) : null;
  // A full record replaces its summary in the index list; the project card
  // derives from whichever it holds, so no summary-only field can go stale.
  const replaceProject = (next) => {
    setSelectedProject((prev) => (prev?.id === next.id ? next : prev));
    summaries.setItems((prev) => prev.map((p) => (p.id === next.id ? next : p)));
  };
  // Open a project the page just received whole (created, forked, started).
  const openProject = (proj) => {
    summaries.setItems((prev) => [proj, ...prev.filter((p) => p.id !== proj.id)]);
    setSelectedProject(proj);
  };
  // The open project leads; summaries fill in the rest of the picker.
  const sortedProjects = useMemo(() => {
    const byId = new Map(summaries.items.map((p) => [p.id, p]));
    if (selected) byId.set(selected.id, selected);
    return [...byId.values()].sort(compareMusicVideoProjectsNewestFirst);
  }, [selected, summaries.items]);
  useEffect(() => {
    if (!stageOnlyParam || !summaries.loaded || summaries.error) return;
    const newest = sortedProjects[0];
    navigate(newest ? `/music-video/${encodeURIComponent(newest.id)}/${stageOnlyParam}` : "/music-video", { replace: true });
  }, [stageOnlyParam, summaries.loaded, summaries.error, sortedProjects, navigate]);
  // Functional merges keyed on the captured projectId/sceneId so an async result
  // that resolves after the user edited the board can't clobber those edits with
  // a stale project snapshot. `patch` may be a function of the current record
  // when the merge has to read a field it is also writing.
  const patchProject = (projectId, patch) => {
    const apply = (project) => ({ ...project, ...(typeof patch === 'function' ? patch(project) : patch) });
    // The picker and index show a project's name/status/recency, so keep those current.
    summaries.setItems((prev) => prev.map((p) => {
      if (p.id !== projectId) return p;
      const { name, status, updatedAt } = apply(p);
      return { ...p, name, status, updatedAt };
    }));
    setSelectedProject((prev) => (prev?.id === projectId ? apply(prev) : prev));
    // A project that isn't open (a render finished after the user navigated
    // away) reads the server's record when it is next fetched. One that is
    // being fetched right now may get a response computed before this patch
    // was persisted, so fetch it again.
    if (fetchingIdRef.current === projectId) setSelectedReload((n) => n + 1);
  };
  const patchScene = (projectId, sceneId, patch) => patchProject(projectId, (project) => ({
    scenes: (project.scenes || []).map((s) => (s.sceneId === sceneId ? { ...s, ...patch } : s)),
  }));

  const youtube = useMusicVideoYoutubeImport({
    routeProjectId,
    navigate,
    onTrackImported,
    onCreateComplete: (track) => setForm((f) => ({
      ...f,
      trackId: track.id,
      ...(!f.name || tracks.some((t) => t.title === f.name) ? { name: track.title || '' } : {}),
    })),
    onProjectUpdated: (proj) => { replaceProject(proj); prepareSong(proj.id); },
  });
  // "Separate vocals" (demucs) — one slot shared by the stem control and the
  // autopilot kickoff; the terminal frame carries the project with its stem.
  const separation = useMusicVideoVocalSeparation({
    onSeparated: (projectId, project) => patchProject(projectId, { vocalStemFilename: project.vocalStemFilename, updatedAt: project.updatedAt }),
  });
  const lyricAlign = useMusicVideoLyricAlign({
    onAligned: (projectId, project) => patchProject(projectId, { lyricCues: project.lyricCues, audioAnalysis: project.audioAnalysis, updatedAt: project.updatedAt }),
  });
  // A track attached or lyrics imported: analyze the song and align never-aligned
  // lines on the server, then follow the alignment here (the Song step shows it).
  const prepareSong = (projectId) => {
    setAnalyzing(true);
    return prepareMusicVideoSong(projectId, { silent: true })
      .then(({ project, analyzed, alignJobId }) => {
        if (analyzed) patchProject(projectId, { audioAnalysis: project.audioAnalysis, updatedAt: project.updatedAt });
        if (alignJobId) lyricAlign.attach(alignJobId, projectId);
      })
      .catch((err) => toast.error(err?.message || 'Could not analyze the song'))
      .finally(() => setAnalyzing(false));
  };
  const midi = useMusicVideoMidiJob({
    onTranscribed: (projectId, midiTranscription) => patchProject(projectId, { midiTranscription }),
  });
  const renderJob = useMusicVideoRenderJob({
    project: selected,
    // A finished, cancelled or dropped render updates or resets the project's
    // status and renderDependencyState: ask the server to sync the full record (#9940).
    onSettled: (reason, projectId) => {
      if (reason === 'error') return;
      getMusicVideoProject(projectId, { silent: true }).then(replaceProject).catch(() => {});
    },
    onRendered: (projectId, result) => patchProject(projectId, (project) => ({
      renderHistoryId: result.id || project.renderHistoryId,
      status: 'complete', renderError: null,
    })),
    onFailed: (projectId, renderError) => patchProject(projectId, { status: 'failed', renderError }),
  });
  // Install-wide catalogs and posting state that outlive a project switch: the
  // video-gen model/LoRA catalog the pickers read, and the publish platforms
  // and history. Both hooks scope their per-project part by id themselves.
  const videoSettings = useMusicVideoModelSettings({ project: selected, onProjectPatch: patchProject });
  // Posting (#9282): fill each platform's post in the PortOS Browser, post on a second press.
  const publishing = useMusicVideoPublishing({ project: selected, replaceProject });

  // Index: name filter lives in the URL (?q=); forks collapse under their root
  // with a per-card version switcher; cards patch in place from run events.
  const nameQuery = searchParams.get('q') || '';
  const setNameQuery = (value) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value) next.set('q', value); else next.delete('q');
    return next;
  }, { replace: true });
  const projectGroups = useMemo(() => groupMusicVideoProjects(sortedProjects, nameQuery), [sortedProjects, nameQuery]);
  const [pickedVersion, setPickedVersion] = useState({}); // rootId -> project id
  useEffect(() => {
    const onRunEvent = (data) => {
      if (data?.project?.id) replaceProject(data.project);
    };
    const events = ['music-video:autonomous', 'music-video:production'];
    events.forEach((e) => socket.on(e, onRunEvent));
    return () => events.forEach((e) => socket.off(e, onRunEvent));
  }, []);

  // `youtube.editJob` is one shared job slot for the whole detail view (not
  // per-project) — switching the selected project while it has an import in
  // flight would silently orphan that job's SSE subscription (the finished
  // track would land in the library but never get attached, since the
  // completion handler's onComplete never fires for a target nobody is
  // listening for anymore) and misattribute its progress UI to whichever
  // project is now selected. Block switching until that import settles. (The
  // hook re-asserts the same invariant against URL-driven navigation.)
  const selectProject = (id, stage = null) => {
    if (youtube.editJob.active && id !== selectedId) {
      toast.error(youtube.switchBlockedMessage);
      return;
    }
    const search = searchParams.toString();
    navigate(id ? `/music-video/${id}${stage ? `/${stage}` : ''}${search ? `?${search}` : ''}` : `/music-video${search ? `?${search}` : ''}`);
  };

  const trackName = useCallback((id) => tracks.find((t) => t.id === id)?.title || id || '—', [tracks]);

  const handleCreate = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    // An audio import in flight hasn't set form.trackId yet — creating now
    // would make a track-less project, and the import's later completion
    // would only fill in the (already-reset) form's trackId instead of
    // attaching to the project the user just created.
    if (youtube.createJob.active) {
      toast.error('Finish or cancel the in-progress audio import before creating the project');
      return;
    }
    if (creating) return;
    setCreating(true);
    // Only the ids go up: the server snapshots the universe/board style and track metadata into the concept.
    createMusicVideoProject({
      name: form.name.trim(),
      mediaMode: form.mediaMode || 'code-images-video',
      mode: form.mode,
      trackId: form.trackId || null,
      concept: { universeId: form.universeId || null, ...(form.characterStyleId ? { characterStyleId: form.characterStyleId } : {}) },
      ...(form.moodBoardId ? { visualSpec: { moodBoardId: form.moodBoardId } } : {}),
      ...(form.mode === 'autonomous' ? { automation: automationFromDraft(form.automation) } : {}),
    }, { silent: true })
      .then((proj) => {
        openProject(proj);
        selectProject(proj.id);
        setForm(emptyCreateForm());
        setCreateOpen(false);
        toast.success('Project created');
        if (proj.trackId) prepareSong(proj.id);
      })
      .catch((err) => toast.error(err?.message || 'Failed to create project'))
      .finally(() => setCreating(false));
  };

  const { isConfirming: isConfirmingDelete, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const handleDeleteRequest = (id) => {
    if (youtube.editJob.active && id === selectedId) {
      toast.error('Finish or cancel the in-progress audio import before deleting this project');
      return;
    }
    requestDelete(id);
  };

  const handleDelete = (id) => {
    // Same hazard selectProject guards against: deleting the project an
    // in-flight edit-surface import targets would still finish server-side
    // and try to PATCH a now-deleted project.
    if (youtube.editJob.active && id === selectedId) {
      toast.error('Finish or cancel the in-progress audio import before deleting this project');
      return;
    }
    deleteMusicVideoProject(id, { silent: true })
      .then(() => {
        summaries.setItems((prev) => prev.filter((p) => p.id !== id));
        if (selectedId === id) navigate('/music-video');
      })
      .catch((err) => toast.error(err?.message || 'Failed to delete project'));
  };

  // The workspace's Project settings drawer and the index cards share one confirm flow.
  const deletion = {
    isConfirming: isConfirmingDelete,
    request: handleDeleteRequest,
    confirm: (id) => confirmDelete(() => handleDelete(id)),
    cancel: cancelDelete,
  };

  const handleClone = (optionsOrTarget = {}, maybeOptions = {}, songRevision = false) => {
    const isTarget = optionsOrTarget && typeof optionsOrTarget.id === 'string';
    const target = isTarget ? optionsOrTarget : selected;
    const options = isTarget ? maybeOptions : (optionsOrTarget || {});

    if (!target || cloningId) return;
    setCloningId(target.id);
    cloneMusicVideoProject(target.id, options, { silent: true })
      .then((project) => {
        openProject(project);
        navigate(`/music-video/${project.id}${songRevision === true ? "/setup" : ""}`);
        toast.success(`Created ${project.name}`);
      })
      .catch((err) => toast.error(err?.message || 'Failed to clone project'))
      .finally(() => setCloningId(null));
  };

  // Resolves with the analyzed project, or null when analysis failed (toasted).
  const handleAnalyze = () => {
    if (!selected) return Promise.resolve(null);
    setAnalyzing(true);
    return analyzeMusicVideoProject(selected.id, { silent: true })
      .then((proj) => { replaceProject(proj); toast.success(`Analyzed — ${proj.audioAnalysis?.bpm ? `${proj.audioAnalysis.bpm} BPM` : 'no tempo detected'}`); return proj; })
      .catch((err) => { toast.error(err?.message || 'Analysis failed'); return null; })
      .finally(() => setAnalyzing(false));
  };

  // A reload (or another tab) leaves server jobs running that this page has no
  // slot for. Reattach alignment, vocal separation and MIDI so Setup shows them
  // running (#10155); each attach is a no-op while its slot is already busy.
  const reattachRef = useRef({});
  reattachRef.current = { lyricAlign, separation, midi };
  useEffect(() => {
    if (!selectedId) return undefined;
    let current = true;
    getMusicVideoActiveJobs(selectedId, { silent: true })
      .then(({ alignment, separation: separationJob, midi: midiJob }) => {
        if (!current) return;
        const slots = reattachRef.current;
        if (alignment) slots.lyricAlign.attach(alignment, selectedId);
        if (separationJob) slots.separation.attach(separationJob, selectedId);
        if (midiJob) slots.midi.attach(midiJob, selectedId);
      })
      .catch(() => {});
    return () => { current = false; };
  }, [selectedId]);
  return (
    // Below md the whole page scrolls (title bar and project header with it), so the step gets the screen.
    <div id={MUSIC_VIDEO_PAGE_ID} className="flex h-full flex-col max-md:overflow-auto">
      <MidiInstallModal {...midi.installGate} />
      <MidiGatedModal {...midi.gatedGate} />
      <PageHeader
        icon={Film}
        title="Music Video"
        subtitle={selected ? null : 'Beat-aware music videos — autopilot or hands-on'}
        actions={(
          <>
            <label htmlFor="mv-project-picker" className="sr-only">Project</label>
            <select
              id="mv-project-picker"
              value={selectedId || ''}
              onChange={(e) => selectProject(e.target.value || null)}
              onFocus={() => setSummariesWanted(true)}
              disabled={loading || youtube.editJob.active}
              className="w-40 min-w-0 max-w-[45vw] sm:w-56 sm:max-w-none bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm disabled:opacity-50"
            >
              <option value="">{loading ? 'Loading projects…' : 'Select a project…'}</option>
              {sortedProjects.map((project) => (
                <option key={project.id} value={project.id}>{formatProjectPickerLabel(project.name)}</option>
              ))}
            </select>
            {!selected && (
              <>
            <button
              type="button"
              onClick={() => setAutonomousOpen(true)}
              title="One prompt in — lyrics, a Suno song, a mood board and the video out"
              className="flex items-center gap-1 rounded border border-port-accent text-port-accent px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0"
            >
              <Wand2 size={15} /> Autonomous
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-1 bg-port-accent text-white rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0"
            >
              <Plus size={15} /> New project
            </button>
              </>
            )}
          </>
        )}
      />

      <CreateProjectDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        form={form}
        onFormChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        tracks={tracks}
        trackLibrary={trackLibrary}
        universes={universes}
        universeResource={universeResource}
        trackName={trackName}
        youtube={youtube}
        onSubmit={handleCreate}
        submitting={creating}
      />

      <AutonomousStartDrawer
        open={autonomousOpen}
        onClose={() => setAutonomousOpen(false)}
        onStarted={(proj) => {
          openProject(proj);
          selectProject(proj.id);
          setAutonomousOpen(false);
        }}
      />

      <div id={MUSIC_VIDEO_SCROLL_ID} className="min-h-0 flex-1 p-4 max-md:flex-none md:overflow-auto md:p-6">
        {projectsError && !selected && (
          <Banner tone="error" size="md" title="Music video projects unavailable" className="mb-4" actions={(
            <button
              type="button"
              onClick={loadProjects}
              disabled={loading}
              className="min-h-[44px] rounded border border-port-error/30 px-3 py-2 text-sm disabled:opacity-50"
            >
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          )}>
            <p>{projectsError}</p>
          </Banner>
        )}
        {!selected && !loading && !projectsError && routeProjectId && !stageOnlyParam && (
          <p className="text-sm text-port-text-muted">
            Project not found — it may have been deleted.{' '}
            <button onClick={() => navigate('/music-video')} className="text-port-accent underline">Back to projects</button>
          </p>
        )}
        {!selected && (loading || !routeProjectId || !!stageOnlyParam) && (
          <div className="space-y-6">
            {/* The header already carries New project / Autonomous: keep the hint, not a second pair of buttons. */}
            <p className="text-sm text-port-text-muted">Pick a project above, start a new one — seed a name, universe and board, choose the tools and a budget, and let autopilot churn — or go fully autonomous from a single prompt.</p>

            {loading ? (
              <div className="text-center py-8 text-sm text-port-text-muted">
                Loading projects…
              </div>
            ) : projectsError ? null : sortedProjects.length === 0 ? (
              <div className="text-center py-6 text-sm text-port-text-muted">
                No music video projects yet. Create your first project above to get started.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-port-text-muted">
                    Projects ({summaries.hasMore ? `${projectGroups.length}+` : projectGroups.length})
                  </h2>
                  <label htmlFor="mv-project-filter" className="sr-only">Filter projects by name</label>
                  <input
                    id="mv-project-filter"
                    type="search"
                    value={nameQuery}
                    onChange={(e) => setNameQuery(e.target.value)}
                    placeholder="Filter by name…"
                    className="min-w-0 w-full sm:w-64 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
                  />
                </div>
                {projectGroups.length === 0 && (
                  <p className="text-sm text-port-text-muted">No projects match &ldquo;{nameQuery}&rdquo;.</p>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="mv-project-grid">
                  {projectGroups.map(({ rootId, versions }) => {
                    const picked = versions.findIndex((v) => v.id === pickedVersion[rootId]);
                    const versionIndex = picked >= 0 ? picked : 0;
                    const project = versions[versionIndex];
                    return (
                      <MusicVideoProjectCard
                        key={rootId}
                        project={project}
                        trackLabel={trackName(project.trackId)}
                        onSelect={() => selectProject(project.id)}
                        onReview={project.preview?.source === 'final' || project.preview?.source === 'animatic' || project.renderHistoryId || latestMusicVideoReviewDraft(project)
                          ? () => selectProject(project.id, 'review') : null}
                        onClone={(options) => handleClone(project, options)}
                        isConfirmingDelete={isConfirmingDelete(project.id)}
                        onRequestDelete={() => handleDeleteRequest(project.id)}
                        onConfirmDelete={() => confirmDelete(() => handleDelete(project.id))}
                        onCancelDelete={cancelDelete}
                        cloning={cloningId === project.id}
                        versionCount={versions.length}
                        versionIndex={versionIndex}
                        onRename={() => {
                          setRenameDraft(project.name || '');
                          setRenamingId(project.id);
                          selectProject(project.id);
                        }}
                        onVersionStep={(delta) => {
                          const target = versions[versionIndex + delta];
                          if (target) setPickedVersion((prev) => ({ ...prev, [rootId]: target.id }));
                        }}
                      />
                    );
                  })}
                </div>
                <InfiniteScrollFooter
                  hasMore={summaries.hasMore}
                  loading={summaries.loading}
                  error={summaries.error}
                  onLoadMore={summaries.loadMore}
                  label="Load more projects"
                />
              </div>
            )}
          </div>
        )}
        {selected && (
          <ProjectWorkspace
            key={selected.id}
            selected={selected}
            tracks={tracks}
            trackLibrary={trackLibrary}
            trackName={trackName}
            youtube={youtube}
            separation={separation}
            lyricAlign={lyricAlign}
            midi={midi}
            renderJob={renderJob}
            videoSettings={videoSettings}
            publishing={publishing}
            analyzing={analyzing}
            cloning={cloning}
            replaceProject={replaceProject}
            patchProject={patchProject}
            patchScene={patchScene}
            openProject={openProject}
            prepareSong={prepareSong}
            onAnalyze={handleAnalyze}
            onClone={handleClone}
            onTrackImported={onTrackImported}
            onRename={handleRename}
            renameForm={renameForm}
            deletion={deletion}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Everything that belongs to ONE open project — its approvals, drafts, the
 * stage tabs, the preview dock, the pickers and drawers — mounted by the page
 * with `key={selected.id}`, so switching projects remounts it with fresh
 * state instead of resetting each piece by hand. What must outlive a switch
 * stays in the page above: the project list and filters, the create form,
 * the page-wide job slots (track import, vocal separation, lyric alignment,
 * MIDI, the final render) and the install-wide catalogs (video models and
 * LoRAs, publish platforms), which this workspace reads through props and
 * binds to its project by id.
 */
function ProjectWorkspace({
  selected, tracks, trackLibrary, trackName, youtube, separation, lyricAlign, midi, renderJob, videoSettings, publishing, analyzing, cloning,
  replaceProject, patchProject, patchScene, openProject, prepareSong, onAnalyze, onClone, onTrackImported,
  onRename, renameForm, deletion,
}) {
  const { projectId: routeProjectId, artifactId: routeArtifactId, stage: routeStage, sceneId: routeSceneId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedId = selected.id;
  const [arranging, setArranging] = useState(false);
  const [creativeSetupPending, setCreativeSetupPending] = useState(false);
  const [styleReferencesPending, setStyleReferencesPending] = useState(false);
  const [compositionSavePending, setCompositionSavePending] = useState(0);
  const [conceptSavePending, setConceptSavePending] = useState(0);
  const [conceptSaveFailures, setConceptSaveFailures] = useState({});
  const conceptSaveChain = useRef(Promise.resolve());
  const conceptSaveVersions = useRef({});
  const conceptSaveSequence = useRef(0);
  const [songStyleReadPending, setSongStyleReadPending] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [importingLyrics, setImportingLyrics] = useState(false);

  const productionReview = useMusicVideoProductionReview({ project: selected, replaceProject });
  // Publish counts every platform the director turned on (#9287), not just any one post.
  const publish = {
    targets: PUBLISH_TARGETS.filter((entry) => publishing.enabledTargets?.includes(entry.target)),
    drafts: publishing.drafts,
  };
  const progress = deriveStages(selected, productionReview.readiness, publish);
  // Which stage tab is open. The URL is the source of truth; with none (or an
  // unknown one) the tab is the stage the project was in when it was opened,
  // pinned so a stage completing mid-session doesn't move the user off the tab
  // they are working in — the header's next action tracks the project instead.
  // The pin latches once readiness (or its failure) is known, so a done project
  // never pins to Cast & Sets; this workspace is mounted per project, so the
  // latch needs no project id.
  const statusKnown = !!productionReview.readiness || !!productionReview.readinessError;
  const openedStageRef = useRef(null);
  if (openedStageRef.current === null && statusKnown) {
    openedStageRef.current = latestMusicVideoReviewDraft(selected) && !selected.renderHistoryId ? 'review' : progress.current;
  }
  const pinnedStage = openedStageRef.current;
  // A shot's card lives on Shots, including links made when it lived on the Storyboard.
  const activeStage = routeSceneId ? 'produce' : (resolveStageParam(routeStage) || pinnedStage || progress.current);
  const storyVisited = useRef(false);
  if (activeStage === 'story') storyVisited.current = true;

  const handleToggleSceneExpand = (sceneId, isExpanded) => {
    if (!selected) return;
    const stage = 'produce';
    if (isExpanded) {
      navigate(`/music-video/${selected.id}/${stage}/scene/${sceneId}`, { replace: true });
    } else if (routeSceneId === sceneId) {
      navigate(`/music-video/${selected.id}/${stage}`, { replace: true });
    }
  };


  // Draft excerpt render (#8986): a fast cue/cut preview of a chosen window,
  // separate from the full-render job/mutex above so a director can preview a
  // change without waiting on (or blocking) a full render.
  const excerpts = useMusicVideoExcerpts({ project: selected, replaceProject });
  // Publishing kit (#9281): release encodes, thumbnails, captions, chapters and copy.
  const publishKit = useMusicVideoPublishKit({ project: selected, replaceProject });
  const tempo = useMusicVideoManualTempo({ project: selected, onUpdated: replaceProject });
  const sceneMedia = useMusicVideoSceneMedia({
    project: selected,
    videoSettings,
    applyScenePatch: patchScene,
  });
  const takes = useMusicVideoTakes({ project: selected, applyScenePatch: patchScene, patchProject });
  // Selective section revision (#8987): regenerate only a draft's flagged
  // sections, resumable from the server's checkpoint.
  const revisions = useMusicVideoRevisions({ project: selected, replaceProject, sceneMedia, attachRender: excerpts.attachRender });
  const autoReview = useMusicVideoAutoReview({ project: selected, replaceProject });
  const production = useMusicVideoProduction({ project: selected, replaceProject });
  const autonomous = useAutonomousMusicVideo({ project: selected, replaceProject });
  // Which finished autonomous stage's output is open (`?run-stage=lyrics`).
  const [runStage, setRunStage] = useDrawerTab('run-stage', null, AUTONOMOUS_VIEWABLE_STAGES);
  // Cast & Sets check-in (before the plan) and the development files it saves.
  const castSets = useMusicVideoCastAndSets({ project: selected, replaceProject });
  const devArtifacts = useMusicVideoDevArtifacts({ project: selected, replaceProject });
  // Pre-production treatment (#8980): brief, compiled arc, shot direction,
  // proof checklist and the non-destructive Apply review.
  const treatment = useMusicVideoTreatment({ project: selected, onProjectPatch: patchProject, replaceProject });
  // The one gallery picker on the page, aimed at either the visual spec's
  // references or one scene's frame takes. This workspace remounts per
  // project, so a picker opened for one project can never write into another.
  const [pickerTarget, setPickerTarget] = useState(null);
  // Unsaved planning edits live here, not in the approval section, so they survive a tab switch (each tab mounts its own section).
  const planningDraft = useState(null);
  // Contact sheet open state lives in the URL (?sheet=contact) so it survives a
  // reload and Back closes it.
  const contactSheetOpen = searchParams.get('sheet') === 'contact';
  const setContactSheetOpen = (open) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (open) next.set('sheet', 'contact'); else { next.delete('sheet'); next.delete('pending'); }
    return next;
  });
  const contactSheetPendingOnly = searchParams.get('pending') === '1';
  const setContactSheetPendingOnly = (on) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (on) next.set('pending', '1'); else next.delete('pending');
    return next;
  });

  // Preparation is already resolving the project's audio at kickoff;
  // relinking the track now would leave the project pointing at a NEW track
  // while the video that finishes rendering was produced from the OLD one.
  const renderTargetsSelected = !!(renderJob.active && selected && renderJob.context === selected.id);
  // `midiTargetsSelected` gates the track-change controls, since the .mid being
  // produced is of the CURRENT audio (mirrors renderTargetsSelected).
  const midiTargetsSelected = !!(midi.active && selected && midi.context === selected.id);

  // Autonomous shot planner (#1855, multi-shot #8964): tile each analyzed
  // section with bounded shots — cut on timed lyric lines, phrase edges and
  // the beat grid, capped at the renderer's clip length — and seed them onto
  // the board, optionally with a first-pass framePrompt/prompt per shot.
  // Director-first — seeded shots are ordinary, fully-editable board entries.
  // `target` lets the autopilot kickoff plan the freshly analyzed record
  // before `selected` re-renders with it.
  const handlePlan = (target = selected, mode) => {
    if (!target?.audioAnalysis) return Promise.resolve();
    setPlanning(true);
    return planMusicVideoProject(target.id, { seedPrompts: true, ...(mode ? { mode } : {}) }, { silent: true })
      .then(({ project, scenesAdded, promptsSeeded, promptsSkippedReason }) => {
        replaceProject(project);
        const suffix = promptsSeeded
          ? ' with first-pass prompts'
          : (promptsSkippedReason && promptsSkippedReason !== 'not-requested' ? ` (prompts skipped: ${aiSkipLabel(promptsSkippedReason)})` : '');
        toast.success(`Planned ${scenesAdded} shot${scenesAdded === 1 ? '' : 's'}${suffix}`);
      })
      .catch((err) => toast.error(err?.message || 'Plan failed'))
      .finally(() => setPlanning(false));
  };

  // Autopilot kickoff: analyze the song, import the track's lyric sheet,
  // separate the vocal, align the words, then plan every shot against the
  // brief (the planner reads automation.guidance). Each step only runs when
  // its result is missing; lyric/vocal/alignment failures still plan.
  const autopilotBlockedReason = (creativeSetupPending || styleReferencesPending)
    ? 'Save or cancel the creative setup before starting autopilot.'
    : autopilotBlocker(selected);
  const kickoff = useMusicVideoKickoff({
    analyze: () => onAnalyze(),
    importLyrics: (project) => importMusicVideoTrackLyrics(project.id, { mode: 'if-empty' }, { silent: true })
      .then(({ project: next, imported }) => {
        patchProject(next.id, { lyricCues: next.lyricCues, lyricMarkers: next.lyricMarkers, updatedAt: next.updatedAt });
        if (imported) toast.success(`Imported ${imported} lyric line${imported === 1 ? '' : 's'} from the track`);
        return next;
      })
      .catch((err) => { toast.error(err?.message || 'Could not import the track lyrics'); return null; }),
    separateVocals: (project) => separation.run(project.id),
    alignLyrics: (project) => lyricAlign.run(project.id)
      .catch((err) => { toast.error(err?.message || 'Could not align the words — planning without word timings'); return null; }),
    castAndSets: (project) => castSets.runToCheckpoint(project),
    cancelCastAndSets: () => castSets.cancelWait(),
    plan: (project) => handlePlan(project),
  });
  // Approve & continue: the kickoff resumes past the check-in and plans —
  // unless a server production run owns this board (it continues on its own).
  const continueAfterCheckin = (res) => {
    const next = res?.project;
    if (!next || (next.scenes || []).length) return;
    if ((next.productionRuns || []).some((r) => r.status === 'running')) return;
    kickoff.run(next);
  };
  const approveCastAndSets = () => castSets.approve().then(continueAfterCheckin);
  const skipCastAndSets = () => castSets.skip().then(continueAfterCheckin);
  const openArtifact = (artifactId) => navigate(`/music-video/${encodeURIComponent(selected.id)}/${activeStage}/dev/${encodeURIComponent(artifactId)}`);
  const closeArtifact = () => navigate(`/music-video/${encodeURIComponent(selected?.id || routeProjectId)}/${activeStage}`);
  const openArtifactRecord = routeArtifactId
    ? (selected?.devArtifacts || []).find((a) => a.id === routeArtifactId && !a.deleted) || null
    : null;
  const artifactVersion = Number(searchParams.get('v')) || openArtifactRecord?.version || null;
  const setArtifactVersion = (version) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (version && version !== openArtifactRecord?.version) next.set('v', String(version)); else next.delete('v');
    return next;
  });
  const handleKickoff = () => {
    if (!selected || analyzing || planning || kickoff.running || autopilotBlockedReason) return;
    kickoff.run(selected);
  };
  // Saving a brief hands the project to autopilot, so mode follows it.
  const saveAutomation = (automation) => updateMusicVideoProject(selected.id, { automation, mode: 'autonomous' }, { silent: true })
    .then((proj) => patchProject(proj.id, { automation: proj.automation, mode: proj.mode, updatedAt: proj.updatedAt }))
    .catch((err) => { toast.error(err?.message || 'Failed to save automation brief'); throw err; });

  // Auto-arrange (#1915): distribute every scene across the analyzed song
  // sections weighted by each section's energy, writing the same persisted
  // startSec/endSec/beatAligned fields the manual drag-snap arranger (#1854)
  // writes — a director-tunable starting point honored exactly at render time.
  // Optimistically applies the whole arrangement to the local board, then
  // persists each scene sequentially (the per-project load-modify-save can't
  // drop a write that way). Silent PATCHes — the catch owns the only error toast.
  const handleAutoArrange = () => {
    if (!selected?.audioAnalysis) return;
    const scenes = selected.scenes || [];
    const arrangement = autoArrangeScenes(scenes, selected.audioAnalysis);
    if (arrangement.length === 0) {
      toast.error('Nothing to arrange — analyze the track and add scenes first');
      return;
    }
    const byId = new Map(arrangement.map((a) => [a.sceneId, a]));
    // Snapshot the pre-arrangement project so a mid-loop PATCH failure can roll the
    // optimistic board back to match the server-side partial state — otherwise the
    // local board shows the complete arrangement over a partial persist until reload.
    const snapshot = selected;
    replaceProject({
      ...selected,
      scenes: scenes.map((s) => {
        const a = byId.get(s.sceneId);
        return a ? { ...s, startSec: a.startSec, endSec: a.endSec, beatAligned: a.beatAligned } : s;
      }),
    });
    setArranging(true);
    (async () => {
      for (const a of arrangement) {
        // Sequential by design — see the comment above (avoids a load-modify-save race).
        await updateMusicVideoScene(
          selected.id, a.sceneId,
          { startSec: a.startSec, endSec: a.endSec, beatAligned: a.beatAligned },
          { silent: true },
        );
      }
    })()
      .then(() => toast.success(`Auto-arranged ${arrangement.length} scene${arrangement.length === 1 ? '' : 's'} by energy`))
      .catch((err) => {
        // Revert the optimistic board to the snapshot so it doesn't show the full
        // arrangement over a server-side partial write.
        replaceProject(snapshot);
        toast.error(err?.message || 'Auto-arrange failed');
      })
      .finally(() => setArranging(false));
  };

  // Re-point the selected project at a different library track (the detail
  // view's "Change track" picker — previously there was no way to relink a
  // project's audio after creation at all).
  const handleChangeTrack = (trackId, { fork = false } = {}) => {
    if (!selected) return;
    if (renderTargetsSelected) {
      toast.error('Wait for the current render to finish before changing the track');
      return;
    }
    const selectedTrack = tracks.find((t) => t.id === trackId);
    const patch = { trackId };
    if (selectedTrack?.concept && !selected.concept?.prompt) {
      patch.concept = { ...(selected.concept || {}), prompt: selectedTrack.concept };
    }
    // The track's Suno style becomes the project's song style on the server.
    // Fork first so the original keeps its analysis/alignment; the new track is
    // applied to the fork only.
    const base = fork
      ? cloneMusicVideoProject(selected.id, {}, { silent: true })
      : Promise.resolve(selected);
    base
      .then((target) => updateMusicVideoProject(target.id, patch, { silent: true }).then((proj) => ({ proj, forked: target !== selected })))
      .then(({ proj, forked }) => {
        if (forked) {
          openProject(proj);
          navigate(`/music-video/${proj.id}/setup`);
        } else replaceProject(proj);
        prepareSong(proj.id);
      })
      .catch((err) => toast.error(err?.message || 'Failed to change track'));
  };

  const handleAddScene = () => {
    addMusicVideoScene(selected.id, { prompt: '' }, { silent: true })
      .then((scene) => replaceProject({ ...selected, scenes: [...(selected.scenes || []), scene] }))
      .catch((err) => toast.error(err?.message || 'Failed to add scene'));
  };

  // A render refusal's one-tap fix: the same patch on each shot it names.
  // Sequential, like auto-arrange, so each PATCH merges against the last.
  const patchShots = (sceneIds, patch, doneMessage) => {
    if (!selected || !sceneIds.length) return Promise.resolve();
    const snapshot = selected;
    const ids = new Set(sceneIds);
    replaceProject({ ...selected, scenes: selected.scenes.map((s) => (ids.has(s.sceneId) ? { ...s, ...patch } : s)) });
    return (async () => {
      for (const sceneId of sceneIds) await updateMusicVideoScene(selected.id, sceneId, patch, { silent: true });
    })()
      .then(() => {
        renderJob.clearFailure();
        toast.success(`${doneMessage} — render again`);
      })
      .catch((err) => {
        replaceProject(snapshot);
        toast.error(err?.message || 'Could not change the shots');
      });
  };

  // A render refused for clips made from since-changed frames: render each shot's clip
  // again from its current frames and the video settings, as Render on its card would.
  const renderClips = (sceneIds) => {
    const scenes = (selected?.scenes || []).filter((scene) => sceneIds.includes(scene.sceneId));
    if (!scenes.length) return Promise.resolve();
    return Promise.all(scenes.map((scene) => sceneMedia.generateSceneVideo(scene))).then((results) => {
      const started = results.filter((result) => result?.ok).length;
      if (!started) return;
      renderJob.clearFailure();
      toast.success(`Rendering ${started === 1 ? 'a new clip' : `${started} new clips`}. Render again once ${started === 1 ? 'it lands' : 'they land'}`);
    });
  };

  // Optimistic local edit; PATCH on blur (silent — this owns its error toast).
  const editSceneLocal = (sceneId, patch) => {
    replaceProject({ ...selected, scenes: selected.scenes.map((s) => (s.sceneId === sceneId ? { ...s, ...patch } : s)) });
  };
  const saveScene = (sceneId, patch) => {
    return updateMusicVideoScene(selected.id, sceneId, patch, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err?.message || 'Failed to save scene'); return false; });
  };

  // Project-level concept/style (issue #3168) — optimistic-local + silent-PATCH on
  // commit, same as commitSceneTiming below. Sends only the changed sub-field;
  // the server merges it into the existing concept (applyProjectPatch), so a
  // stale local copy can't clobber a sibling sub-field. Consumed by
  // buildScenePlanPrompt (AI Plan) and by the server's frame and clip composers
  // (lib/musicVideoShotPrompt.js), both already reading concept.
  const commitConcept = (patch) => {
    const version = ++conceptSaveSequence.current;
    for (const key of Object.keys(patch)) conceptSaveVersions.current[key] = version;
    patchProject(selected.id, (project) => ({ concept: { ...project.concept, ...patch } }));
    setConceptSavePending((count) => count + 1);
    const run = conceptSaveChain.current.then(() => updateMusicVideoProject(selected.id, { concept: patch }, { silent: true }));
    conceptSaveChain.current = run.catch(() => {});
    return run.then(() => {
      setConceptSaveFailures((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => conceptSaveVersions.current[key] !== version)));
    }).catch((err) => {
      setConceptSaveFailures((previous) => ({ ...previous, ...Object.fromEntries(Object.entries(patch).filter(([key]) => conceptSaveVersions.current[key] === version)) }));
      toast.error(err?.message || 'Failed to save concept');
    })
      .finally(() => setConceptSavePending((count) => count - 1));
  };
  // Lyric cues / phrases / pacing (#8964) and the typography manifest (#8984)
  // — optimistic-local + silent PATCH on blur, like the scene editors. Each PATCH replaces a whole list, so the
  // saves are chained: two quick blurs can never land out of order and let an
  // older snapshot of the list overwrite a newer one.
  const timedTextSaveChain = useRef(Promise.resolve());
  const editProjectLocal = (patch) => patchProject(selected.id, patch);
  // The finishing film look, saved whole from the image viewer's editor ("Use on project").
  const saveFilmLook = (filmLook) => {
    const projectId = selected.id;
    return updateMusicVideoProject(projectId, { filmLook }, { silent: true })
      .then((saved) => patchProject(projectId, { filmLook: saved.filmLook ?? null }));
  };
  const saveProjectFields = (patch, { applyComposition = false } = {}) => {
    const projectId = selected.id;
    setCompositionSavePending((count) => count + 1);
    timedTextSaveChain.current = timedTextSaveChain.current
      .then(() => updateMusicVideoProject(projectId, patch, { silent: true }))
      .then((saved) => {
        if (applyComposition) patchProject(projectId, { composition: saved.composition });
        // The server moves markers with their cues when lines are removed or merged.
        if (patch.lyricCues) patchProject(projectId, { lyricMarkers: saved.lyricMarkers });
      })
      .catch((err) => toast.error(err?.message || 'Failed to save changes'))
      .finally(() => setCompositionSavePending((count) => count - 1));
    return timedTextSaveChain.current;
  };
  const handleImportLyrics = (body, onDone) => {
    const projectId = selected.id;
    setImportingLyrics(true);
    importMusicVideoLyrics(projectId, body, { silent: true })
      .then(({ project, imported, format }) => {
        patchProject(projectId, { lyricCues: project.lyricCues, lyricMarkers: project.lyricMarkers, updatedAt: project.updatedAt });
        onDone?.();
        toast.success(`Imported ${imported} lyric line${imported === 1 ? '' : 's'} (${format})`);
        prepareSong(projectId);
      })
      .catch((err) => toast.error(err?.message || 'Lyric import failed'))
      .finally(() => setImportingLyrics(false));
  };
  // "Use track lyrics": replace the lines with the linked track's sheet.
  const handleImportTrackLyrics = () => {
    const projectId = selected.id;
    setImportingLyrics(true);
    importMusicVideoTrackLyrics(projectId, { mode: 'replace' }, { silent: true })
      .then(({ project, imported, markers }) => {
        patchProject(projectId, { lyricCues: project.lyricCues, lyricMarkers: project.lyricMarkers, updatedAt: project.updatedAt });
        toast.success(`Imported ${imported} lyric line${imported === 1 ? '' : 's'}${markers ? ` and ${markers} section/direction marker${markers === 1 ? '' : 's'}` : ''} from the track`);
        prepareSong(projectId);
      })
      .catch((err) => toast.error(err?.message || 'Could not import the track lyrics'))
      .finally(() => setImportingLyrics(false));
  };
  // A re-align is a click (imports align through prepareSong). The panel shows
  // the alignment setup error itself, so this request stays silent.
  const handleAlignLyrics = (cueId, options) => lyricAlign.run(selected.id, cueId, options);
  // Revise song: open the new version on its Song step and follow its re-time job there.
  const handleSongRevised = ({ project, retimeJobId }) => {
    openProject(project);
    navigate(`/music-video/${project.id}/setup`);
    if (retimeJobId) lyricAlign.attach(retimeJobId, project.id);
    toast.success(`Created ${project.name} with the new song`);
  };
  const handleRetimeSong = () => lyricAlign.run(selected.id, null, { retimeSong: true })
    .catch((err) => toast.error(err?.message || 'Could not re-time to the new song'));
  // The slot is page-wide but the job belongs to one project: only that
  // project's Setup shows "Aligning…".
  const aligningLyrics = Boolean(lyricAlign.active && selected && lyricAlign.context?.projectId === selected.id);
  const alignStatus = aligningLyrics ? { label: lyricAlign.stageLabel, percent: lyricAlign.percent, onCancel: lyricAlign.cancel } : null;

  // Buffered so a concept/style keystroke doesn't fire a round-trip per character,
  // and a focus-without-edit blur doesn't re-PATCH an unchanged value.
  const conceptDraft = useFieldDraft(selected?.concept?.prompt, (v) => commitConcept({ prompt: v }));
  const styleDraft = useFieldDraft(selected?.concept?.style, (v) => commitConcept({ style: v }));
  const songStyleDraft = useFieldDraft(selected?.concept?.songStyle, (v) => commitConcept({ songStyle: v }));
  // This workspace remounts per project, so a still-focused, unblurred draft
  // cannot survive a project switch and be committed onto the next project.
  // Re-read the song style (with its excluded styles) from the song's Suno link.
  const songStyleFromSuno = (url) => {
    setSongStyleReadPending(true);
    return refreshMusicVideoSongStyleFromSuno(selected.id, url, { silent: true })
      .then(({ project, excludedStylesKnown }) => {
        songStyleDraft.reset();
        patchProject(project.id, (current) => ({ concept: { ...current.concept, songStyle: project.concept?.songStyle }, updatedAt: project.updatedAt }));
        if (excludedStylesKnown) toast.success('Song style read from Suno');
        else toast.warning('Read the style, but Suno only shows excluded styles when the PortOS Browser is signed in to Suno');
        return true;
      })
      .catch((err) => { toast.error(err?.message || 'Could not read the song style from Suno'); return false; })
      .finally(() => setSongStyleReadPending(false));
  };
  // BeatTimeline drag commit — same optimistic-local + silent-PATCH pattern as
  // the other scene field editors (#1854).
  const commitSceneTiming = (sceneId, patch) => {
    editSceneLocal(sceneId, patch);
    saveScene(sceneId, patch);
  };

  // Visual spec (#8965) — optimistic local merge, then a chained PATCH whose
  // response carries server-minted reference ids back onto the board.
  const visualSpecSaveChain = useRef(Promise.resolve());
  const saveVisualSpec = (patch) => {
    const projectId = selected.id;
    patchProject(projectId, (p) => ({ visualSpec: { ...(p.visualSpec || {}), ...patch } }));
    visualSpecSaveChain.current = visualSpecSaveChain.current
      .then(() => updateMusicVideoProject(projectId, { visualSpec: patch }, { silent: true }))
      .then((proj) => { if (proj?.visualSpec) patchProject(projectId, { visualSpec: proj.visualSpec }); })
      .catch((err) => toast.error(err?.message || 'Failed to save visual spec'));
  };
  const handlePickerSelect = (item) => {
    if (!item?.filename || !pickerTarget || !selected) return;
    if (pickerTarget.type === 'reference') {
      const references = selected.visualSpec?.references || [];
      if (references.some((ref) => ref.imageId === item.filename)) return;
      saveVisualSpec({ references: [...references, { imageId: item.filename, role: 'mood', condition: false }] });
      return;
    }
    const scene = (selected.scenes || []).find((s) => s.sceneId === pickerTarget.sceneId);
    if (scene) takes.importTake(scene, item);
  };
  // Per-scene "Import clip take" (#8978) — pick an existing video-history
  // clip and add it as a take, mirroring handlePickerSelect's image path.
  const handleClipPickerSelect = (item) => {
    if (!item?.id || !pickerTarget || pickerTarget.type !== 'clip' || !selected) return;
    const scene = (selected.scenes || []).find((s) => s.sceneId === pickerTarget.sceneId);
    if (scene) takes.importClipTake(scene, item);
  };

  const handleDeleteScene = (sceneId) => {
    deleteMusicVideoScene(selected.id, sceneId, { silent: true })
      .then((proj) => replaceProject(proj))
      .catch((err) => toast.error(err?.message || 'Failed to delete scene'));
  };

  // #8977: split a shot its backend cannot render in one take on lyric/phrase
  // boundaries. `backend` is the lane the card measured against.
  // `atSec` cuts the shot in two at that song time instead (the card's "Split shot").
  const handleSplitScene = (sceneId, backend, atSec = null) => {
    splitMusicVideoScene(selected.id, sceneId, backend, { atSec, silent: true })
      .then(({ project, scenes }) => {
        replaceProject(project);
        toast.success(`Split into ${pluralize(scenes.length, 'shot')}`);
      })
      .catch((err) => toast.error(err?.message || 'Failed to split scene'));
  };

  // Join a scene with the next one (the inverse of the split above).
  const handleMergeNextScene = (sceneId, backend) => {
    mergeMusicVideoNextScene(selected.id, sceneId, backend, { silent: true })
      .then(({ project }) => {
        replaceProject(project);
        toast.success('Merged with the next shot');
      })
      .catch((err) => toast.error(err?.message || 'Failed to merge scenes'));
  };

  // Extend a scene back over the previous one, which is removed (the mirror of the merge above).
  const handleMergePreviousScene = (sceneId, backend) => {
    mergeMusicVideoPreviousScene(selected.id, sceneId, backend, { silent: true })
      .then(({ project }) => {
        replaceProject(project);
        toast.success('Merged over the previous shot');
      })
      .catch((err) => toast.error(err?.message || 'Failed to merge scenes'));
  };

  // Move the cut before a shot: it starts at `startSec` and the shot before it ends there.
  const handleMoveSceneStart = (sceneId, startSec) => moveMusicVideoSceneStart(selected.id, sceneId, startSec, { silent: true })
    .then(({ project }) => replaceProject(project))
    .catch((err) => toast.error(err?.message || 'Failed to move the shot start'));

  const moveScene = (idx, dir) => {
    const scenes = selected.scenes || [];
    const target = idx + dir;
    if (target < 0 || target >= scenes.length) return;
    const ids = scenes.map((s) => s.sceneId);
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    // The server keeps each slot's song timing and lyric and moves the shots
    // between them, so the moved shot now plays at its neighbor's time.
    const moved = scenes[idx];
    const wasApproved = !!productionReview.readiness?.storyboard?.approved;
    reorderMusicVideoScenes(selected.id, ids, { silent: true })
      .then((proj) => {
        replaceProject(proj);
        const now = (proj.scenes || []).find((s) => s.sceneId === moved.sceneId);
        if (now) seekToScene(now);
        const at = typeof now?.startSec === 'number' ? ` to ${formatTimecode(now.startSec)}` : '';
        toast.success(`Moved ${moved.label || 'shot'}${at}${wasApproved ? '; re-approve the storyboard' : ''}`);
      })
      .catch((err) => toast.error(err?.message || 'Failed to reorder'));
  };

  const canContinueShot = videoSettings.settings.backend === 'local'
    && videoSettings.settings.generationMode === 'image'
    && isLtx2FamilyRuntime(videoSettings.activeModel?.runtime);

  // Final render filename is NOT the history id — resolve once at page level so
  // the lightbox item and the inline player share the same lookup (#3718).
  const finalVideo = useVideoFileSrc(selected?.renderHistoryId, {
    enabled: !!selected?.renderHistoryId,
  });

  // Shared lightbox: final render first (it sits above the board), then each
  // scene's frame then clip in board order. Built through media/normalize so
  // keys use the canonical `image:<filename>` / `video:<historyId>` shape —
  // the lightbox's always-mounted Add-to-collection / Pin-to-moodboard menus
  // then get a real `id`/`filename` ref (same vocabulary as Media History's
  // ?preview=), and the lineage fields survive.
  //
  // The prompts here are the board's LABELS: `useMusicVideoSceneMedia` suffixes
  // `project.concept.style` onto both the frame and the shot prompt on the way
  // out, and the final render has no prompt of its own at all. They stand in
  // until `useHydratedPreviewRoute` reads the real one back on open.
  const previewItems = useMemo(() => {
    if (!selected) return [];
    const items = [];
    // `generateThumbnail` always writes `<jobId>.jpg`, which the history record
    // only names once hydrated — keep the job-scoped poster so the card has one
    // on first paint.
    const videoItem = (id, filename, prompt) => ({
      ...normalizeVideo({ id, filename, prompt }),
      previewUrl: videoPosterForJob(id),
    });
    if (selected.renderHistoryId && finalVideo.src) {
      items.push(videoItem(
        selected.renderHistoryId,
        finalVideo.src.split('/').pop() || selected.renderHistoryId,
        `Music Video: ${selected.name}`,
      ));
    }
    // Every take (#8965), start and end frames included, selected first, so the take strips and contact sheet
    // can open any candidate in the shared lightbox.
    for (const scene of selected.scenes || []) {
      const frames = sceneTakeList(scene, 'image')
        .sort((a, b) => (b.assetId === scene.referenceImageId) - (a.assetId === scene.referenceImageId));
      for (const take of frames) {
        items.push(normalizeImage({ filename: take.assetId, prompt: take.prompt || scene.framePrompt || scene.prompt || '' }));
      }
      const endFrames = sceneTakeList(scene, 'endImage')
        .sort((a, b) => (b.assetId === scene.endImageId) - (a.assetId === scene.endImageId));
      for (const take of endFrames) {
        items.push(normalizeImage({ filename: take.assetId, prompt: take.prompt || scene.endFramePrompt || scene.prompt || '' }));
      }
      const clips = sceneTakeList(scene, 'video')
        .sort((a, b) => (b.assetId === scene.videoHistoryId) - (a.assetId === scene.videoHistoryId));
      for (const take of clips) {
        items.push(videoItem(take.assetId, `${take.assetId}.mp4`, take.prompt || scene.prompt || ''));
      }
    }
    // Cast & sets references and their inputs open here too, never as a raw file.
    items.push(...castAndSetsPreviewItems(selected.castAndSets));
    // Scenes can reuse the same frame/clip (Make's generation controls surface a
    // "Repetition: N unique frames" badge). Dedupe by key so prev/next and
    // openPreview's .find() land on a single item rather than the first of
    // several identical keys with different prompts.
    return [...new Map(items.map((i) => [i.key, i])).values()];
  }, [selected, finalVideo.src]);
  const [preview, setPreview] = useHydratedPreviewRoute(previewItems);
  const openPreview = useCallback((key) => {
    if (!key) return;
    const match = previewItems.find((i) => i.key === key);
    if (match) setPreview(match);
  }, [previewItems, setPreview]);

  // ---- stage plumbing -------------------------------------------------------
  // A header action that lands on a control (Attach a track, Set up production)
  // scrolls to and focuses it once its stage has rendered.
  const location = useLocation();
  useEffect(() => {
    const anchor = location.hash.slice(1);
    if (!anchor || !selected) return;
    const el = document.getElementById(anchor);
    if (!el) return;
    // An anchor inside a folded section (Production review, a Publish card or
    // platform row) unfolds it first; a React-state fold renders a frame later.
    const land = () => {
      el.scrollIntoView?.({ block: 'start', behavior: 'instant' });
      const focusable = el.matches('[tabindex], button, input, select, textarea, a') ? el : el.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a');
      focusable?.focus?.({ preventScroll: true });
    };
    if (unfoldToAnchor(el)) requestAnimationFrame(land);
    else land();
  }, [activeStage, location.key, selectedId, !!selected]);
  // Edit shot (from the preview player) opens that shot's card on Shots, in the side panel.
  const editShot = (sceneId) => {
    if (!selected) return;
    const search = searchParams.toString();
    navigate(`/music-video/${encodeURIComponent(selected.id)}/produce/scene/${encodeURIComponent(sceneId)}${search ? `?${search}` : ''}`, { replace: activeStage === 'produce' });
  };
  const goToStage = (stage, anchor = null, params = null) => {
    // Preserve search params (e.g. ?play=, ?new=, ?sheet=) across tabs; `params` sets more (e.g. ?scenes=missing).
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(params || {})) next.set(key, value);
    const search = next.toString();
    navigate(`/music-video/${encodeURIComponent(selected.id)}/${stage}${search ? `?${search}` : ''}${anchor ? `#${anchor}` : ''}`, { replace: activeStage === stage });
  };
  // Project settings (render style, audio tools, autopilot, files) is a drawer
  // over the open step; `?mvPanel=<tab>` says it is open and on which tab.
  const settingsParam = searchParams.get('mvPanel');
  const settingsTab = SETTINGS_TAB_IDS.includes(settingsParam) ? settingsParam : null;
  const setSettingsTab = (tab) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (tab) next.set('mvPanel', tab);
    else next.delete('mvPanel');
    return next;
  }, { replace: !!tab && !!settingsTab });
  // The header's Autopilot button stands in for the attention row's Open: a run
  // waiting on its checkpoint opens Autopilot at the editor, like that row did.
  const openHeaderSettings = (tab) => {
    if (tab !== 'autopilot' || selected?.autonomousRun?.status !== 'awaiting-approval') { setSettingsTab(tab); return; }
    const next = new URLSearchParams(searchParams);
    next.set('mvPanel', 'autopilot');
    navigate({ search: `?${next}`, hash: '#mv-auto-edit' });
  };

  // The preview: scene cards and storyboard rows seek it. Steps reviewed by
  // watching put it first (open); elsewhere, below xl, it is a folded row until
  // the director opens it. `dockCollapsed` is null until they toggle it.
  const [seekRequest, setSeekRequest] = useState(null);
  const [dockCollapsed, setDockCollapsed] = useState(null);
  const [dockExpanded, setDockExpanded] = useState(false);
  // `play` starts playback from there (a storyboard row); a scene card only cues the shot.
  const seekToScene = (scene, { play = false } = {}) => {
    if (typeof scene?.startSec !== 'number') return;
    setSeekRequest((prev) => ({ t: scene.startSec, n: (prev?.n || 0) + 1, play }));
  };

  // The project's master audio file lives under data/music/ — either the linked
  // track's stored audio or the project's own uploaded file: the bare basename
  // (or null when the project has no audio yet) for the preview/download
  // controls; the bytes are served statically via trackAudioUrl().
  const audioFilename = selected.trackId
    ? tracks.find((t) => t.id === selected.trackId)?.audioFilename || null
    : selected.uploadedAudioFilename || null;
  const audioUrl = audioFilename ? trackAudioUrl(audioFilename) : null;
  const autopilotRun = selected?.autonomousRun || null;
  const productionNextAction = selected ? deriveNextAction(selected, {
    readiness: productionReview.readiness,
    publish,
    renderActive: renderTargetsSelected,
    draftActive: excerpts.rendering,
    proofActive: productionReview.proof.active,
    renderProgress: renderJob.progress,
    renderPending: renderJob.pending,
    renderBlockedByOther: !!renderJob.active && !renderTargetsSelected,
    kickoffRunning: kickoff.running,
    kickoffStep: kickoff.stepLabel,
    kickoffBlockedReason: autopilotBlockedReason,
    planning,
    analyzing,
  }) : null;
  const reviewingDraft = activeStage === 'review' && !!latestMusicVideoReviewDraft(selected) && !selected?.renderHistoryId;
  const reviewDraftState = useMusicVideoReviewDraft(selected, { enabled: reviewingDraft });
  const reviewDraft = reviewDraftState.draft;
  const nextAction = reviewingDraft ? reviewDraftState.checking
    ? { id: 'review-imported', kind: 'goto', stage: 'review', label: 'Checking review draft', disabled: true, reason: 'Checking exact-version media availability' }
    : reviewDraft
      ? { id: 'review-imported', kind: 'goto', stage: 'review', label: 'Review imported draft', shortLabel: 'Review draft' }
      : { id: 'review-files', kind: 'open', label: 'Choose review file', shortLabel: 'Choose file' }
    : productionNextAction;
  // What the server holds that this tab might not be showing (#9940): derived
  // from the saved record, so it survives a reload. Work this tab can see
  // progressing (spinning sections, an attached render) is not flagged.
  const attentionItems = selected ? deriveAttentionItems(selected, {
    generatingSceneIds: new Set([...Object.keys(sceneMedia.genScenes || {}), ...Object.keys(sceneMedia.genVideoScenes || {})]
      .filter((sceneId) => sceneMedia.genScenes?.[sceneId] || sceneMedia.genVideoScenes?.[sceneId])),
    draftRendering: excerpts.rendering,
    finalRenderAttached: renderTargetsSelected,
    readiness: productionReview.readiness,
    headerAction: nextAction,
    stage: activeStage,
  }) : [];
  // A checklist row either jumps to the control that settles it or, for work
  // the page can start itself (build or resume the cast & sets, fill the art
  // direction from an approved sheet), starts it.
  // Revising re-plans or regenerates in place; the requests stay open until the director resolves each one.
  const reviseFromFeedback = async (stage) => {
    const result = await productionReview.revise(stage);
    if (!result) return;
    const count = result.revision?.sceneIds?.length;
    toast.success(stage === 'art' ? 'Cast & Sets is regenerating with these requests. Review the new sheet, then resolve each request.'
      : stage === 'storyboard' ? `Revised ${formatCount(count)} shot${count === 1 ? '' : 's'}. Review them, then resolve each request.`
        : 'A revised composition is ready. Render and review a new proof, then resolve each request.');
  };
  // "Keep approved" on a stale approval: the Cast & Sets check-in is re-stamped on its
  // current inputs; a production approval is given again on the current revision.
  const keepApproval = (stage) => (stage === 'castAndSets' ? castSets.reconfirm() : productionReview.approve(stage));
  const runChecklistAction = (action) => {
    if (action.run === 'start-cast-sets') { castSets.start(); return; }
    if (action.run === 'resume-cast-sets') { castSets.resume(); return; }
    if (action.run === 'prepare-art') { productionReview.prepare(); return; }
    if (action.run === 'resolve-feedback') { productionReview.resolveFeedback(action.feedbackId, ''); return; }
    if (action.run === 'revise-feedback') { reviseFromFeedback(action.stage); return; }
    if (action.run === 'keep-approval') { keepApproval(action.stage); return; }
    if (action.run === 'sync-lyric-anchors') { productionReview.syncLyricAnchors(); return; }
    if (action.run === 'remove-stale-rows') { productionReview.removeStaleRows(); return; }
    if (action.editShot) { editShot(action.editShot); return; }
    goToStage(action.stage || activeStage, action.anchor, action.params);
  };
  const runNextAction = () => {
    if (!selected || !nextAction || nextAction.disabled || compositionSavePending > 0) return;
    if (nextAction.id === 'review-imported') { openArtifact(reviewDraft.artifactId); return; }
    if (nextAction.id === 'review-files') { setSettingsTab('files'); return; }
    if (nextAction.id === 'review-autonomous') { setSettingsTab('autopilot'); return; }
    if (nextAction.kind === 'goto') { goToStage(nextAction.stage, nextAction.anchor); return; }
    switch (nextAction.id) {
      case 'kickoff': handleKickoff(); break;
      case 'analyze': onAnalyze(); break;
      case 'plan': handlePlan(); break;
      case 'approve-cast-sets': approveCastAndSets(); break;
      case 'resume-cast-sets': castSets.resume(); break;
      case 'start-cast-sets': castSets.start(); break;
      case 'stop-production': production.stop(nextAction.runId); break;
      case 'resume-production': production.resume(nextAction.runId, nextAction.acceptBasis ? { acceptBasis: true } : {}); break;
      case 'resume-autonomous':
      case 'retry-autonomous':
        autonomous.resume();
        break;
      case 'render-final': renderJob.start(selected.id); break;
      default: break;
    }
  };

  // Everything the stage panels need, in one place: stages read what they
  // use, so a panel moving between tabs never changes a signature here.
  // The opening credit block is part of the look: on the Look step it is edited under the preview that draws it.
  const withTitleCard = (dock) => (activeStage !== 'cast-sets' || !selected ? dock : (
    <div className="flex flex-col gap-3">
      {dock}
      <TitleCardPanel project={selected} onEditLocal={editProjectLocal} onSave={saveProjectFields}
        onPreview={(startSec) => seekToScene({ startSec }, { play: true })} />
      <StatsOutroPanel project={selected} onEditLocal={editProjectLocal} onSave={saveProjectFields} />
      <CreditsOutroPanel project={selected} onEditLocal={editProjectLocal} onSave={saveProjectFields} />
    </div>
  ));
  const board = selected ? {
    project: selected,
    reviewDraftState,
    activeSceneId: routeSceneId || null,
    onToggleSceneExpand: handleToggleSceneExpand,
    onEditShot: editShot,
    autopilotRun,
    autonomous,
    runStage,
    onSelectStage: setRunStage,
    productionReadiness: productionReview.readiness,
    onRevertApproval: productionReview.revert,
    locked: creativeSetupPending || styleReferencesPending || compositionSavePending > 0,
    storySavePending: conceptSavePending > 0 || Object.keys(conceptSaveFailures).length > 0 || songStyleReadPending || treatment.pendingWrites > 0 || treatment.applying,
    conceptSaveFailures,
    conceptSavePending,
    retryConceptSave: () => commitConcept(conceptSaveFailures),
    busy: { analyzing, planning, arranging, cloning },
    tracks,
    trackLibrary,
    onForkSong: () => onClone({}, {}, true),
    trackName,
    audioFilename,
    audioUrl,
    youtube,
    separation,
    midi,
    midiBound: midiTargetsSelected,
    renderBound: renderTargetsSelected,
    tempo,
    videoSettings,
    sceneMedia,
    renderJob,
    onPatchShots: patchShots,
    onRenderClips: renderClips,
    production,
    castSets,
    devArtifacts,
    takes,
    treatment,
    excerpts,
    publishKit,
    publishing,
    revisions,
    autoReview,
    finalVideo,
    kickoff,
    conceptDraft,
    styleDraft,
    songStyleDraft,
    songStyleFromSuno,
    importingLyrics,
    aligningLyrics,
    alignStatus,
    autopilotBlockedReason,
    canContinueShot,
    replaceProject,
    patchStoryProject: (patch) => patchProject(selected.id, patch),
    saveStoryLink: (storyboardId) => updateMusicVideoProject(selected.id, { storyboardId }, { silent: true })
      .then((saved) => { patchProject(saved.id, { storyboardId: saved.storyboardId, updatedAt: saved.updatedAt }); return saved; }),
    editProjectLocal,
    saveProjectFields,
    saveCompositionGrade: (patch) => saveProjectFields(patch, { applyComposition: true }),
    saveVisualSpec,
    saveAutomation,
    saveMediaMode: (mediaMode) => updateMusicVideoProject(selected.id, { mediaMode }, { silent: true })
      .then((project) => patchProject(project.id, { mediaMode: project.mediaMode, updatedAt: project.updatedAt }))
      .catch((err) => toast.error(err?.message || 'Failed to save the media mode')),
    saveCreativeSetup: (patch) => updateMusicVideoProject(selected.id, patch, { silent: true }).then((project) => {
      patchProject(project.id, { concept: project.concept, visualSpec: project.visualSpec, productionPolicy: project.productionPolicy });
    }),
    applyCastLinks: ({ concept, updatedAt }) => patchProject(selected.id, { concept, ...(updatedAt ? { updatedAt } : {}) }),
    // Only labels still empty here: an edit made while the request ran keeps its own.
    applyReferenceLabels: (labels) => patchProject(selected.id, (p) => ({ visualSpec: { ...(p.visualSpec || {}),
      references: (p.visualSpec?.references || []).map((ref) => (labels[ref.id] && !ref.label?.trim() ? { ...ref, label: labels[ref.id] } : ref)) } })),
    setCreativeSetupPending,
    setStyleReferencesPending,
    saveStyleReferences: (patch) => updateMusicVideoProject(selected.id, patch, { silent: true }).then((project) => {
      patchProject(project.id, { styleReferences: project.styleReferences });
    }),
    setPickerTarget,
    onAddReference: () => setPickerTarget({ type: 'reference' }),
    onAnalyze: () => onAnalyze(),
    onPlan: (mode) => handlePlan(selected, mode),
    onAutoArrange: handleAutoArrange,
    onKickoff: handleKickoff,
    onChangeTrack: handleChangeTrack,
    onImportLyrics: handleImportLyrics,
    onImportTrackLyrics: handleImportTrackLyrics,
    onAlignLyrics: handleAlignLyrics,
    onSongRevised: handleSongRevised,
    onRetimeSong: handleRetimeSong,
    retimeStatus: alignStatus,
    onTrackImported,
    onAddScene: handleAddScene,
    onDeleteScene: handleDeleteScene,
    onSplitScene: handleSplitScene,
    onMergeNextScene: handleMergeNextScene,
    onMergePreviousScene: handleMergePreviousScene,
    onMoveSceneStart: handleMoveSceneStart,
    onRepairPerformance: revisions.repairPerformance,
    repairBusy: revisions.busy,
    onRenderStyle: (mode) => {
      const composition = compositionDraft(selected, { mode });
      editProjectLocal({ composition });
      saveProjectFields({ composition });
    },
    onUploadArtifact: (file, fields) => devArtifacts.upload(file, fields).then((res) => {
      if (res?.artifact) openArtifact(res.artifact.id);
    }),
    editSceneLocal,
    saveScene,
    moveScene,
    commitSceneTiming,
    approveCastAndSets,
    skipCastAndSets,
    // Choose a Development file as the art-direction visual guide (saved with the rest of the draft).
    useAsGuide: (artifactId) => productionReview.save({ ...EMPTY_PRODUCTION_DRAFT, ...(selected.productionReview?.draft || {}), guideArtifactId: artifactId }),
    goToStage,
    openSettings: setSettingsTab,
    productionReview,
    planningDraft,
    openArtifact,
    openPreview,
    openContactSheet: () => setContactSheetOpen(true),
    seekToScene,
  } : null;
  const StageView = STAGE_VIEWS[activeStage];
  const playerFirst = PLAYER_FIRST_STAGES.has(activeStage);
  const projectStatus = !selected ? null : statusKnown && productionReview.readiness
    ? describeProjectStatus(selected, { progress, nextAction: productionNextAction, reviewingDraft, reviewDraftState })
    : statusKnown
      ? { headline: `Status unavailable: ${productionReview.readinessError}`, tone: 'warn', needsYouStage: null }
      : { headline: 'Loading status…', tone: 'muted', needsYouStage: null };

  const reviewStage = selected ? approvalStageFor(activeStage, selected, productionReview.readiness, productionReview.proof.active) : null;
  const previewSources = selected ? listPreviewSources(selected, { finalVideoSrc: finalVideo.src, leadWith: activeStage === 'review' ? 'drafts' : activeStage === 'produce' ? 'storyboard' : activeStage === 'setup' ? 'lyrics' : 'final' }) : [];

  return (
    <>
      <MediaPreview preview={preview} setPreview={setPreview} items={previewItems}
        filmLookProject={selected ? { look: selected.filmLook, name: selected.name, onSave: saveFilmLook } : null} />
      {pickerTarget && pickerTarget.type !== 'clip' && (
        <GalleryImagePicker
          open
          allowUpload
          onClose={() => setPickerTarget(null)}
          onSelect={handlePickerSelect}
        />
      )}
      {pickerTarget && pickerTarget.type === 'clip' && (
        <GalleryVideoPicker
          open
          onClose={() => setPickerTarget(null)}
          onSelect={handleClipPickerSelect}
        />
      )}
      <DevArtifactDrawer
          key={routeArtifactId || 'none'}
          open={!!routeArtifactId}
          onClose={closeArtifact}
          project={selected}
          artifact={openArtifactRecord}
          version={artifactVersion}
          onVersionChange={setArtifactVersion}
          ops={devArtifacts}
          busy={devArtifacts.busy || castSets.busy}
          castAndSets={{ regenerate: () => castSets.regenerate(), approveAndContinue: approveCastAndSets }}
        />
      <ContactSheetDrawer
          open={contactSheetOpen}
          onClose={() => setContactSheetOpen(false)}
          project={selected}
          busy={takes.busy}
          onSelectTake={takes.selectTake}
          onReviewTake={takes.reviewTake}
          onOpenPreview={openPreview}
          pendingOnly={contactSheetPendingOnly}
          onPendingOnlyChange={setContactSheetPendingOnly}
          onRegenerateFrame={sceneMedia.generateFrame}
          generatingScenes={sceneMedia.genScenes}
        />
          <ProjectSettingsDrawer open={!!settingsTab} tab={settingsTab || 'project'} onTabChange={setSettingsTab} onClose={() => setSettingsTab(null)}
            board={board}
            manageActions={(
              <ProjectManageActions
                project={selected}
                cloning={cloning}
                onFork={(options) => onClone(options)}
                confirmingDelete={deletion.isConfirming(selected.id)}
                onDeleteRequest={() => deletion.request(selected.id)}
                onDeleteConfirm={() => deletion.confirm(selected.id)}
                onDeleteCancel={deletion.cancel}
              />
            )}
          />
          <MusicVideoLayout
            project={selected}
            trackLabel={trackName(selected.trackId)}
            stage={activeStage}
            onStageChange={(stage) => goToStage(stage)}
            progress={progress}
            nextAction={compositionSavePending > 0 && nextAction ? { ...nextAction, disabled: true, reason: 'Saving composition…' } : nextAction}
            onNextAction={runNextAction}
            spend={projectSpend(selected)}
            status={projectStatus}
            notes={stepNotes(selected, productionReview.readiness, publish)}
            autopilot={autopilotStatus(selected, productionReview.readiness)}
            onOpenSettings={openHeaderSettings}
            playerFirst={playerFirst}
            previewExpanded={dockExpanded}
            onRename={onRename}
            renameForm={renameForm}
            cancelRender={renderTargetsSelected && !renderJob.pending ? { onCancel: renderJob.cancel, cancelling: renderJob.cancelling } : null}
            lead={activeStage === 'story' ? null : (
              <StageChecklist
                items={stageChecklist(activeStage, selected, productionReview.readiness, publish)}
                onAction={runChecklistAction}
                busy={castSets.busy || productionReview.busy}
                onRevert={productionReview.revert}
                headerAnchor={nextAction?.kind === 'goto' ? nextAction.anchor : null}
              />
            )}
            review={reviewStage ? (
              <ProductionReviewPanel
                key={`${selected.id}-${activeStage}`}
                project={selected}
                review={productionReview}
                onOpenArtifact={openArtifact}
                stage={reviewStage}
                planning={planningDraft}
                onNavigate={goToStage}
                onSeek={(startSec) => seekToScene({ startSec }, { play: true })}
              />
            ) : null}
            attention={(
              <NeedsAttentionBanner
                // A parked autonomous or production run with nothing to resume, while the
                // header's Autopilot button reports that run, is that button (which opens it); no second row.
                items={autopilotStatus(selected).label === 'Autopilot' ? attentionItems
                  : attentionItems.filter((item) => !(['autonomous', 'production'].includes(item.kind) && !item.canResume))}
                busy={revisions.busy || castSets.busy || autoReview.busy || autonomous.busy || production.busy || renderJob.reattaching}
                actions={{
                  onResumeRevision: revisions.resume,
                  onCancelRevision: revisions.cancel,
                  onResumeCastAndSets: () => castSets.resume(),
                  onContinueAutoReview: (runId) => autoReview.resume(runId),
                  onCancelAutoReview: (runId) => autoReview.cancel(runId),
                  onReattachRender: () => renderJob.reattach(selected.id),
                  onResumeAutonomous: () => autonomous.resume(),
                  onResumeProduction: (runId, opts) => production.resume(runId, opts),
                  onKeepApproval: keepApproval,
                  onRevertApproval: productionReview.revert,
                }}
              />
            )}
            dock={NO_DOCK_STAGES.has(activeStage) ? null : withTitleCard(
              <PreviewDock
                project={selected}
                sources={previewSources}
                audioUrl={audioUrl}
                seekRequest={seekRequest}
                collapsed={dockCollapsed ?? !playerFirst}
                onToggleCollapsed={() => setDockCollapsed(!(dockCollapsed ?? !playerFirst))}
                expanded={dockExpanded}
                onToggleExpanded={!playerFirst ? () => setDockExpanded((expanded) => !expanded) : undefined}
                onEditShot={editShot}
              />,
            )}
          >
            {storyVisited.current && <div hidden={activeStage !== 'story'}><StoryStage board={board} active={activeStage === 'story'} /></div>}
            {activeStage !== 'story' && <StageView board={board} />}
          </MusicVideoLayout>
    </>
  );
}
