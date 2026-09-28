import CreativeSetupPanel from '../components/musicVideo/CreativeSetupPanel.jsx';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import { Plus, Film } from 'lucide-react';
import toast from '../components/ui/Toast';
import AutoSizeTextarea from '../components/ui/AutoSizeTextarea';
import PageHeader from '../components/PageHeader';
import {
  listMusicVideoProjects,
  createMusicVideoProject,
  cloneMusicVideoProject,
  updateMusicVideoProject,
  deleteMusicVideoProject,
  analyzeMusicVideoProject,
  planMusicVideoProject,
  addMusicVideoScene,
  updateMusicVideoScene,
  deleteMusicVideoScene,
  splitMusicVideoScene,
  reorderMusicVideoScenes,
  importMusicVideoLyrics,
} from '../services/apiMusicVideo.js';
import useFieldDraft from '../hooks/useFieldDraft.js';
import useMusicVideoYoutubeImport from '../hooks/useMusicVideoYoutubeImport.js';
import useMusicVideoMidiJob from '../hooks/useMusicVideoMidiJob.js';
import useMusicVideoRenderJob from '../hooks/useMusicVideoRenderJob.js';
import useMusicVideoExcerpts from '../hooks/useMusicVideoExcerpts.js';
import useMusicVideoRevisions from '../hooks/useMusicVideoRevisions.js';
import useMusicVideoAutoReview from '../hooks/useMusicVideoAutoReview.js';
import useMusicVideoModelSettings from '../hooks/useMusicVideoModelSettings.js';
import useMusicVideoManualTempo from '../hooks/useMusicVideoManualTempo.js';
import useMusicVideoSceneMedia from '../hooks/useMusicVideoSceneMedia.js';
import useMusicVideoTakes from '../hooks/useMusicVideoTakes.js';
import useMusicVideoTreatment from '../hooks/useMusicVideoTreatment.js';
import useHydratedPreviewRoute from '../hooks/useHydratedPreviewRoute.js';
import { normalizeImage, normalizeVideo } from '../components/media/normalize.js';
import { useVideoFileSrc } from '../hooks/useVideoFileSrc.js';
import MediaPreview from '../components/media/MediaPreview.jsx';
import MidiInstallModal from '../components/install/MidiInstallModal.jsx';
import MidiGatedModal from '../components/install/MidiGatedModal.jsx';
import { listTracks } from '../services/apiTracks.js';
import BeatTimeline from '../components/musicVideo/BeatTimeline.jsx';
import CreateProjectDrawer from '../components/musicVideo/CreateProjectDrawer.jsx';
import AutomationPanel from '../components/musicVideo/AutomationPanel.jsx';
import { automationDraftFrom, automationFromDraft } from '../lib/musicVideoAutomation.js';
import { getUniverse, listUniverseNames } from '../services/apiUniverseBuilder.js';
import { getMoodBoard } from '../services/apiMoodBoard.js';
import { universeStyleSnapshot, moodBoardStyleSnapshot } from '../lib/musicVideoUniverseRefs.js';
import ProjectToolbar from '../components/musicVideo/ProjectToolbar.jsx';
import TrackPanel from '../components/musicVideo/TrackPanel.jsx';
import RenderStatusPanel from '../components/musicVideo/RenderStatusPanel.jsx';
import ExcerptPanel from '../components/musicVideo/ExcerptPanel.jsx';
import AnalysisPanel from '../components/musicVideo/AnalysisPanel.jsx';
import SceneCard from '../components/musicVideo/SceneCard.jsx';
import LyricsPanel from '../components/musicVideo/LyricsPanel.jsx';
import TypographyPanel from '../components/musicVideo/TypographyPanel.jsx';
import VisualSpecPanel from '../components/musicVideo/VisualSpecPanel.jsx';
import TreatmentPanel from '../components/musicVideo/TreatmentPanel.jsx';
import HandoffControls from '../components/musicVideo/HandoffControls.jsx';
import ContactSheetDrawer from '../components/musicVideo/ContactSheetDrawer.jsx';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker.jsx';
import GalleryVideoPicker from '../components/videoGen/GalleryVideoPicker.jsx';
import { autoArrangeScenes } from '../lib/beatGrid.js';
import { isLtx2FamilyRuntime } from '../lib/runnerFamilies';
import { videoPosterForJob } from '../lib/creativeDirectorPreview.js';
import { sceneTakeList } from '../lib/musicVideoTakes.js';

// Automation first: a new project defaults to autopilot with the free tools.
const emptyCreateForm = () => ({
  name: '', mode: 'autonomous', trackId: '', universeId: '', moodBoardId: '', automation: automationDraftFrom(null),
});

// Why the autopilot kickoff can't run yet, or null when it can.
function autopilotBlocker(project) {
  if (!project) return null;
  if (!project.trackId && !project.uploadedAudioFilename) return 'Attach a track before starting autopilot.';
  if ((project.scenes || []).length > 0) return 'The board already has shots — edit them below or fork a new version to re-plan.';
  return null;
}

const STATUS_COLORS = {
  draft: 'bg-port-border text-port-text',
  analyzed: 'bg-port-accent/30 text-port-accent',
  ready: 'bg-port-accent/30 text-port-accent',
  rendering: 'bg-port-warning/30 text-port-warning',
  complete: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
};

export default function MusicVideo() {
  // Deep-linkable project selection: the selected project lives in the URL
  // (/music-video/:projectId) rather than local state, so a project's
  // scene board is directly shareable/bookmarkable and reachable from the
  // media job-completion hooks. selectProject() navigates; the browser URL is
  // the single source of truth for "which project is open".
  const { projectId: routeProjectId } = useParams();
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [universes, setUniverses] = useState(null);
  const selectedId = routeProjectId || null;
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [creativeSetupPending, setCreativeSetupPending] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [importingLyrics, setImportingLyrics] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyCreateForm);
  const selected = projects.find((p) => p.id === selectedId) || null;

  const replaceProject = (next) => setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)));
  // Functional merges keyed on the captured projectId/sceneId so an async result
  // that resolves after the user edited the board can't clobber those edits with
  // a stale project snapshot. `patch` may be a function of the current record
  // when the merge has to read a field it is also writing.
  const patchProject = (projectId, patch) =>
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) }
      : p)));
  const patchScene = (projectId, sceneId, patch) =>
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, scenes: (p.scenes || []).map((s) => (s.sceneId === sceneId ? { ...s, ...patch } : s)) }
      : p)));

  const youtube = useMusicVideoYoutubeImport({
    routeProjectId,
    navigate,
    onTrackImported: (track) => setTracks((prev) => [...prev, track]),
    onCreateComplete: (track) => setForm((f) => ({ ...f, trackId: track.id })),
    onProjectUpdated: replaceProject,
  });
  const midi = useMusicVideoMidiJob({
    onTranscribed: (projectId, midiTranscription) => patchProject(projectId, { midiTranscription }),
  });
  const renderJob = useMusicVideoRenderJob({
    onRendered: (projectId, result) => patchProject(projectId, (project) => ({
      renderHistoryId: result.id || project.renderHistoryId,
      status: 'complete',
    })),
    onFailed: (projectId) => patchProject(projectId, { status: 'failed' }),
  });
  // Draft excerpt render (#8986): a fast cue/cut preview of a chosen window,
  // separate from the full-render job/mutex above so a director can preview a
  // change without waiting on (or blocking) a full render.
  const excerpts = useMusicVideoExcerpts({ project: selected, replaceProject });
  const videoSettings = useMusicVideoModelSettings({ project: selected, onProjectPatch: patchProject });
  const tempo = useMusicVideoManualTempo({ project: selected, onUpdated: replaceProject });
  const sceneMedia = useMusicVideoSceneMedia({
    project: selected,
    videoSettings,
    applyScenePatch: patchScene,
  });
  const takes = useMusicVideoTakes({ project: selected, applyScenePatch: patchScene });
  // Selective section revision (#8987): regenerate only a draft's flagged
  // sections, resumable from the server's checkpoint.
  const revisions = useMusicVideoRevisions({ project: selected, replaceProject, sceneMedia, attachRender: excerpts.attachRender });
  const autoReview = useMusicVideoAutoReview({ project: selected, replaceProject, submitSections: revisions.submitSections });
  // Pre-production treatment (#8980): brief, compiled arc, shot direction,
  // proof checklist and the non-destructive Apply review.
  const treatment = useMusicVideoTreatment({ project: selected, onProjectPatch: patchProject, replaceProject });
  // The one gallery picker on the page, aimed at either the visual spec's
  // references or one scene's frame takes. Cleared on a project switch so a
  // picker opened for one project can never write into another.
  const [pickerTarget, setPickerTarget] = useState(null);
  useEffect(() => { setPickerTarget(null); }, [selectedId]);
  // Contact sheet open state lives in the URL (?sheet=contact) so it survives a
  // reload and Back closes it.
  const [searchParams, setSearchParams] = useSearchParams();
  const contactSheetOpen = searchParams.get('sheet') === 'contact';
  const setContactSheetOpen = (open) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (open) next.set('sheet', 'contact'); else next.delete('sheet');
    return next;
  });

  // Preparation is already resolving the project's audio at kickoff;
  // relinking the track now would leave the project pointing at a NEW track
  // while the video that finishes rendering was produced from the OLD one.
  const renderTargetsSelected = !!(renderJob.active && selected && renderJob.context === selected.id);
  // `midiTargetsSelected` gates the track-change controls, since the .mid being
  // produced is of the CURRENT audio (mirrors renderTargetsSelected).
  const midiTargetsSelected = !!(midi.active && selected && midi.context === selected.id);

  // `youtube.editJob` is one shared job slot for the whole detail view (not
  // per-project) — switching the selected project while it has an import in
  // flight would silently orphan that job's SSE subscription (the finished
  // track would land in the library but never get attached, since the
  // completion handler's onComplete never fires for a target nobody is
  // listening for anymore) and misattribute its progress UI to whichever
  // project is now selected. Block switching until that import settles. (The
  // hook re-asserts the same invariant against URL-driven navigation.)
  const selectProject = (id) => {
    if (youtube.editJob.active && id !== selectedId) {
      toast.error(youtube.switchBlockedMessage);
      return;
    }
    navigate(id ? `/music-video/${id}` : '/music-video');
  };

  useEffect(() => {
    listMusicVideoProjects({ silent: true })
      .then((data) => { setProjects(data || []); setLoading(false); })
      .catch((err) => { toast.error(err?.message || 'Failed to load music video projects'); setLoading(false); });
    listTracks({ silent: true }).then((t) => setTracks(t || [])).catch(() => setTracks([]));
    listUniverseNames({ silent: true }).then((u) => setUniverses(u || [])).catch(() => setUniverses([]));
  }, []);

  const trackName = useCallback((id) => tracks.find((t) => t.id === id)?.title || id || '—', [tracks]);

  // The project's master audio file lives under data/music/ — either the linked
  // track's stored audio or the project's own uploaded file. Returns the bare
  // basename (or null when the project has no audio yet) for the preview/download
  // controls; the bytes are served statically via trackAudioUrl().
  const projectAudioFilename = useCallback((project) => {
    if (!project) return null;
    if (project.trackId) return tracks.find((t) => t.id === project.trackId)?.audioFilename || null;
    return project.uploadedAudioFilename || null;
  }, [tracks]);

  const handleCreate = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    // A YouTube import in flight hasn't set form.trackId yet — creating now
    // would make a track-less project, and the import's later completion
    // would only fill in the (already-reset) form's trackId instead of
    // attaching to the project the user just created.
    if (youtube.createJob.active) {
      toast.error('Finish or cancel the in-progress YouTube import before creating the project');
      return;
    }
    if (creating) return;
    setCreating(true);
    // Snapshot the chosen universe/board style into the concept at creation,
    // the same authored copy the creative setup panel saves.
    Promise.all([
      form.universeId ? getUniverse(form.universeId, { silent: true }) : null,
      form.moodBoardId ? getMoodBoard(form.moodBoardId, { silent: true }) : null,
    ])
      .then(([universe, board]) => createMusicVideoProject({
        name: form.name.trim(),
        mode: form.mode,
        trackId: form.trackId || null,
        concept: {
          universeId: form.universeId || null,
          universeStyle: universeStyleSnapshot(universe),
          moodBoardStyle: moodBoardStyleSnapshot(board),
        },
        ...(form.moodBoardId ? { visualSpec: { moodBoardId: form.moodBoardId } } : {}),
        ...(form.mode === 'autonomous' ? { automation: automationFromDraft(form.automation) } : {}),
      }, { silent: true }))
      .then((proj) => {
        setProjects((prev) => [...prev, proj]);
        selectProject(proj.id);
        setForm(emptyCreateForm());
        setCreateOpen(false);
        toast.success('Project created');
      })
      .catch((err) => toast.error(err?.message || 'Failed to create project'))
      .finally(() => setCreating(false));
  };

  const handleDelete = (id) => {
    // Same hazard selectProject guards against: deleting the project an
    // in-flight edit-surface import targets would still finish server-side
    // and try to PATCH a now-deleted project.
    if (youtube.editJob.active && id === selectedId) {
      toast.error('Finish or cancel the in-progress YouTube import before deleting this project');
      return;
    }
    deleteMusicVideoProject(id, { silent: true })
      .then(() => {
        setProjects((prev) => prev.filter((p) => p.id !== id));
        if (selectedId === id) navigate('/music-video');
      })
      .catch((err) => toast.error(err?.message || 'Failed to delete project'));
  };

  const handleClone = () => {
    if (!selected || cloning) return;
    setCloning(true);
    cloneMusicVideoProject(selected.id, {}, { silent: true })
      .then((project) => {
        setProjects((prev) => [...prev, project]);
        navigate(`/music-video/${project.id}`);
        toast.success(`Created ${project.name}`);
      })
      .catch((err) => toast.error(err?.message || 'Failed to clone project'))
      .finally(() => setCloning(false));
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

  // Autonomous shot planner (#1855, multi-shot #8964): tile each analyzed
  // section with bounded shots — cut on timed lyric lines, phrase edges and
  // the beat grid, capped at the renderer's clip length — and seed them onto
  // the board, optionally with a first-pass framePrompt/prompt per shot.
  // Director-first — seeded shots are ordinary, fully-editable board entries.
  // `target` lets the autopilot kickoff plan the freshly analyzed record
  // before `selected` re-renders with it.
  const handlePlan = (target = selected) => {
    if (!target?.audioAnalysis) return Promise.resolve();
    setPlanning(true);
    return planMusicVideoProject(target.id, { seedPrompts: true }, { silent: true })
      .then(({ project, scenesAdded, promptsSeeded, promptsSkippedReason }) => {
        replaceProject(project);
        const suffix = promptsSeeded
          ? ' with first-pass prompts'
          : (promptsSkippedReason && promptsSkippedReason !== 'not-requested' ? ` (prompts skipped: ${promptsSkippedReason})` : '');
        toast.success(`Planned ${scenesAdded} shot${scenesAdded === 1 ? '' : 's'}${suffix}`);
      })
      .catch((err) => toast.error(err?.message || 'Plan failed'))
      .finally(() => setPlanning(false));
  };

  // Autopilot kickoff: analyze the song when it has no beat map yet, then plan
  // every shot against the brief (the planner reads automation.guidance).
  const autopilotBlockedReason = autopilotBlocker(selected);
  const handleKickoff = () => {
    if (!selected || analyzing || planning || autopilotBlockedReason) return;
    (selected.audioAnalysis ? Promise.resolve(selected) : handleAnalyze())
      .then((proj) => (proj?.audioAnalysis ? handlePlan(proj) : null));
  };
  // Saving a brief hands the project to autopilot, so mode follows it.
  const saveAutomation = (automation) => updateMusicVideoProject(selected.id, { automation, mode: 'autonomous' }, { silent: true })
    .then((proj) => patchProject(proj.id, { automation: proj.automation, mode: proj.mode, updatedAt: proj.updatedAt }))
    .catch((err) => { toast.error(err?.message || 'Failed to save autopilot brief'); throw err; });

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
  const handleChangeTrack = (trackId) => {
    if (!selected) return;
    if (renderTargetsSelected) {
      toast.error('Wait for the current render to finish before changing the track');
      return;
    }
    updateMusicVideoProject(selected.id, { trackId }, { silent: true })
      .then((proj) => replaceProject(proj))
      .catch((err) => toast.error(err?.message || 'Failed to change track'));
  };

  const handleAddScene = () => {
    addMusicVideoScene(selected.id, { prompt: '' }, { silent: true })
      .then((scene) => replaceProject({ ...selected, scenes: [...(selected.scenes || []), scene] }))
      .catch((err) => toast.error(err?.message || 'Failed to add scene'));
  };

  // Optimistic local edit; PATCH on blur (silent — this owns its error toast).
  const editSceneLocal = (sceneId, patch) => {
    replaceProject({ ...selected, scenes: selected.scenes.map((s) => (s.sceneId === sceneId ? { ...s, ...patch } : s)) });
  };
  const saveScene = (sceneId, patch) => {
    updateMusicVideoScene(selected.id, sceneId, patch, { silent: true })
      .catch((err) => toast.error(err?.message || 'Failed to save scene'));
  };

  // Project-level concept/style (issue #3168) — optimistic-local + silent-PATCH on
  // commit, same as commitSceneTiming below. Sends only the changed sub-field;
  // the server merges it into the existing concept (applyProjectPatch), so a
  // stale local copy can't clobber a sibling sub-field. Consumed by
  // buildScenePlanPrompt (AI Plan) and by buildFramePrompt/buildShotPrompt's
  // style suffix, both already reading concept.
  const commitConcept = (patch) => {
    replaceProject({ ...selected, concept: { ...selected.concept, ...patch } });
    updateMusicVideoProject(selected.id, { concept: patch }, { silent: true })
      .catch((err) => toast.error(err?.message || 'Failed to save concept'));
  };
  // Lyric cues / phrases / pacing (#8964) and the typography manifest (#8984)
  // — optimistic-local + silent PATCH on blur, like the scene editors. Each PATCH replaces a whole list, so the
  // saves are chained: two quick blurs can never land out of order and let an
  // older snapshot of the list overwrite a newer one.
  const timedTextSaveChain = useRef(Promise.resolve());
  const editProjectLocal = (patch) => patchProject(selected.id, patch);
  const saveProjectFields = (patch) => {
    const projectId = selected.id;
    timedTextSaveChain.current = timedTextSaveChain.current
      .then(() => updateMusicVideoProject(projectId, patch, { silent: true }))
      .catch((err) => toast.error(err?.message || 'Failed to save changes'));
  };
  const handleImportLyrics = (body, onDone) => {
    const projectId = selected.id;
    setImportingLyrics(true);
    importMusicVideoLyrics(projectId, body, { silent: true })
      .then(({ project, imported, format }) => {
        patchProject(projectId, { lyricCues: project.lyricCues, updatedAt: project.updatedAt });
        onDone?.();
        toast.success(`Imported ${imported} lyric line${imported === 1 ? '' : 's'} (${format})`);
      })
      .catch((err) => toast.error(err?.message || 'Lyric import failed'))
      .finally(() => setImportingLyrics(false));
  };
  // Buffered so a concept/style keystroke doesn't fire a round-trip per character,
  // and a focus-without-edit blur doesn't re-PATCH an unchanged value.
  const conceptDraft = useFieldDraft(selected?.concept?.prompt, (v) => commitConcept({ prompt: v }));
  const styleDraft = useFieldDraft(selected?.concept?.style, (v) => commitConcept({ style: v }));
  // The route (not a remount) drives which project is "selected" here, so a
  // still-focused, unblurred draft survives a project switch (deep link,
  // browser Back, future ⌘K/voice jump) with the OLD project's typed text.
  // Without this, the next incidental blur would commit that leftover draft
  // onto the NEW project via commitConcept's captured `selected`. Discard
  // (never auto-commit) any pending edit the instant the selection changes.
  useEffect(() => { conceptDraft.reset(); styleDraft.reset(); }, [selectedId]);
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
  const handleSplitScene = (sceneId, backend) => {
    splitMusicVideoScene(selected.id, sceneId, backend, { silent: true })
      .then(({ project, scenes }) => {
        replaceProject(project);
        toast.success(`Split into ${scenes.length} shots`);
      })
      .catch((err) => toast.error(err?.message || 'Failed to split scene'));
  };

  const moveScene = (idx, dir) => {
    const scenes = selected.scenes || [];
    const target = idx + dir;
    if (target < 0 || target >= scenes.length) return;
    const ids = scenes.map((s) => s.sceneId);
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    reorderMusicVideoScenes(selected.id, ids, { silent: true })
      .then((proj) => replaceProject(proj))
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
    // Every take (#8965), selected first, so the take strips and contact sheet
    // can open any candidate in the shared lightbox.
    for (const scene of selected.scenes || []) {
      const frames = sceneTakeList(scene, 'image')
        .sort((a, b) => (b.assetId === scene.referenceImageId) - (a.assetId === scene.referenceImageId));
      for (const take of frames) {
        items.push(normalizeImage({ filename: take.assetId, prompt: take.prompt || scene.framePrompt || scene.prompt || '' }));
      }
      const clips = sceneTakeList(scene, 'video')
        .sort((a, b) => (b.assetId === scene.videoHistoryId) - (a.assetId === scene.videoHistoryId));
      for (const take of clips) {
        items.push(videoItem(take.assetId, `${take.assetId}.mp4`, take.prompt || scene.prompt || ''));
      }
    }
    // Scenes can reuse the same frame/clip (ProjectToolbar surfaces a
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

  return (
    <div className="space-y-4">
      <MidiInstallModal {...midi.installGate} />
      <MidiGatedModal {...midi.gatedGate} />
      <MediaPreview preview={preview} setPreview={setPreview} items={previewItems} />
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
      {selected && (
        <ContactSheetDrawer
          open={contactSheetOpen}
          onClose={() => setContactSheetOpen(false)}
          project={selected}
          busy={takes.busy}
          onSelectTake={takes.selectTake}
          onReviewTake={takes.reviewTake}
          onOpenPreview={openPreview}
        />
      )}
      <PageHeader
        icon={Film}
        title="Music Video"
        subtitle="Beat-aware music videos — autopilot or hands-on"
        actions={(
          <>
            <label htmlFor="mv-project-picker" className="sr-only">Project</label>
            <select
              id="mv-project-picker"
              value={selectedId || ''}
              onChange={(e) => selectProject(e.target.value || null)}
              disabled={loading || youtube.editJob.active}
              className="min-w-0 w-full sm:w-72 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm disabled:opacity-50"
            >
              <option value="">{loading ? 'Loading projects…' : 'Select a project…'}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · {project.scenes?.length || 0} scenes · {project.status}
                </option>
              ))}
            </select>
            {selected && (
              <span className="flex items-center gap-1">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-port-border">v{selected.version || 1}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLORS[selected.status] || 'bg-port-border'}`}>
                  {selected.status}
                </span>
              </span>
            )}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-1 bg-port-accent text-white rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0"
            >
              <Plus size={15} /> New project
            </button>
          </>
        )}
      />

      <CreateProjectDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        form={form}
        onFormChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        tracks={tracks}
        universes={universes}
        trackName={trackName}
        youtube={youtube}
        onSubmit={handleCreate}
        submitting={creating}
      />


      <div>
        {!selected && !loading && routeProjectId && (
          <p className="text-sm text-port-text-muted">
            Project not found — it may have been deleted.{' '}
            <button onClick={() => navigate('/music-video')} className="text-port-accent underline">Back to projects</button>
          </p>
        )}
        {!selected && (loading || !routeProjectId) && (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center">
            <p className="text-sm text-port-text-muted mb-3">Pick a project in the header, or start a new one — seed a name, universe and board, choose the tools and a budget, and let autopilot churn.</p>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-1 bg-port-accent text-white rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0"
            >
              <Plus size={15} /> New music video
            </button>
          </div>
        )}
        {selected && (
          <div className="space-y-3">
            <AutomationPanel
              key={`automation-${selected.id}`}
              project={selected}
              onSave={saveAutomation}
              onKickoff={handleKickoff}
              kickoffBusy={analyzing || planning}
              kickoffBlockedReason={autopilotBlockedReason}
            />
            <CreativeSetupPanel key={`creative-${selected.id}`} project={selected} onPendingChange={setCreativeSetupPending}
              onSave={(patch) => updateMusicVideoProject(selected.id, patch, { silent: true }).then((project) => {
                patchProject(project.id, { concept: project.concept, visualSpec: project.visualSpec });
              })} />
            <fieldset disabled={creativeSetupPending} className="space-y-3 min-w-0">
            <div className="bg-port-card border border-port-border rounded-lg p-3">
              <ProjectToolbar
                project={selected}
                midi={midi}
                midiBound={midiTargetsSelected}
                videoSettings={videoSettings}
                sceneMedia={sceneMedia}
                renderJob={renderJob}
                busy={{ analyzing, planning, arranging, cloning }}
                onAnalyze={handleAnalyze}
                onPlan={() => handlePlan()}
                onAutoArrange={handleAutoArrange}
                onClone={handleClone}
                onDelete={() => handleDelete(selected.id)}
              />
              {/* Restricted-model license gate for the saved scene-video
                  renderer. Only mounts while that exact license is still
                  unaccepted — after download-time acknowledgement it stays
                  off the board. */}

              {/* Concept & style — optional global direction for the whole video,
                  set before "AI Plan" (see commitConcept above for what reads it). */}
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label htmlFor="mv-concept" className="block text-xs text-port-text-muted mb-1">Concept</label>
                  <AutoSizeTextarea
                    id="mv-concept"
                    value={conceptDraft.value}
                    rows={2}
                    maxLength={8000}
                    onChange={conceptDraft.onChange}
                    onBlur={conceptDraft.onBlur}
                    placeholder="What is this video about — story, theme, or narrative thread for the AI plan to build on."
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px]"
                  />
                </div>
                <div>
                  <label htmlFor="mv-style" className="block text-xs text-port-text-muted mb-1">Visual style</label>
                  <AutoSizeTextarea
                    id="mv-style"
                    value={styleDraft.value}
                    rows={2}
                    maxLength={2000}
                    onChange={styleDraft.onChange}
                    onBlur={styleDraft.onBlur}
                    placeholder="Art style, references, palette, mood — appended to every generated frame and shot prompt."
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px]"
                  />
                </div>
              </div>
              <VisualSpecPanel
                key={selected.id}
                project={selected}
                onSave={saveVisualSpec}
                onAddReference={() => setPickerTarget({ type: 'reference' })}
              />
              <TreatmentPanel key={`treatment-${selected.id}`} project={selected} treatment={treatment} />
              <HandoffControls
                projectId={selected.id}
                busy={takes.busy}
                onExport={takes.exportHandoff}
                onExportBundle={takes.exportHandoffBundle}
                onImport={takes.importHandoffFiles}
                onOpenContactSheet={() => setContactSheetOpen(true)}
              />
              <TrackPanel
                project={selected}
                tracks={tracks}
                trackName={trackName}
                audioFilename={projectAudioFilename(selected)}
                youtube={youtube}
                renderBound={renderTargetsSelected}
                midiBound={midiTargetsSelected}
                onChangeTrack={handleChangeTrack}
                onProjectUpdated={replaceProject}
              />
              <RenderStatusPanel
                rendering={renderTargetsSelected}
                progress={renderJob.progress}
                renderHistoryId={selected.renderHistoryId}
                finalVideo={finalVideo}
                onOpenPreview={openPreview}
              />
              <ExcerptPanel
                project={selected}
                rendering={excerpts.rendering}
                progress={excerpts.progress}
                excerpts={selected.excerpts || []}
                deletingId={excerpts.deletingId}
                noteBusyId={excerpts.noteBusyId}
                startExcerpt={excerpts.startExcerpt}
                cancelExcerpt={excerpts.cancelExcerpt}
                deleteExcerpt={excerpts.deleteExcerpt}
                addNote={excerpts.addNote}
                editNote={excerpts.editNote}
                deleteNote={excerpts.deleteNote}
                revision={{ ...revisions, genScenes: sceneMedia.genScenes, genVideoScenes: sceneMedia.genVideoScenes }}
                autoReview={autoReview}
              />
              <LyricsPanel
                project={selected}
                onEditLocal={editProjectLocal}
                onSave={saveProjectFields}
                onImport={handleImportLyrics}
                importing={importingLyrics}
              />
              <TypographyPanel
                project={selected}
                onEditLocal={editProjectLocal}
                onSave={saveProjectFields}
              />
              <AnalysisPanel
                audioAnalysis={selected.audioAnalysis}
                scenes={selected.scenes || []}
                tempo={tempo}
              />
            </div>

            {selected.audioAnalysis && (selected.scenes || []).length > 0 && (
              <BeatTimeline audioAnalysis={selected.audioAnalysis} scenes={selected.scenes} lyricCues={selected.lyricCues} onCommit={commitSceneTiming} />
            )}

            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Scene board</h3>
              <button onClick={handleAddScene} className="flex items-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0">
                <Plus size={15} /> Add scene
              </button>
            </div>

            {(selected.scenes || []).length === 0 && <p className="text-sm text-port-text-muted">No scenes yet — add one to start the board.</p>}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {(selected.scenes || []).map((scene, idx) => (
                <SceneCard
                  key={scene.sceneId}
                  scene={scene}
                  index={idx}
                  isLast={idx === selected.scenes.length - 1}
                  generatingFrame={sceneMedia.genScenes[scene.sceneId]}
                  generatingVideo={sceneMedia.genVideoScenes[scene.sceneId]}
                  settingsSaving={videoSettings.saving}
                  videoBlockedReason={videoSettings.videoBlockedReason}
                  lipSyncBackend={videoSettings.audioReactiveSelected ? 'local' : videoSettings.settings.backend}
                  songDurationSec={selected.audioAnalysis?.durationSec ?? null}
                  canContinueShot={canContinueShot}
                  onMove={moveScene}
                  onDelete={handleDeleteScene}
                  onSplit={handleSplitScene}
                  onEditLocal={editSceneLocal}
                  onSave={saveScene}
                  onGenerateFrame={sceneMedia.generateFrame}
                  onGenerateVideo={sceneMedia.generateSceneVideo}
                  onContinueVideo={sceneMedia.continueSceneVideo}
                  onOpenPreview={openPreview}
                  takeBusy={takes.busy}
                  onSelectTake={takes.selectTake}
                  onReviewTake={takes.reviewTake}
                  onImportTake={(target) => setPickerTarget({ type: 'take', sceneId: target.sceneId })}
                  onImportClipTake={(target) => setPickerTarget({ type: 'clip', sceneId: target.sceneId })}
                  layered={selected.composition?.mode === 'composed'}
                />
              ))}
            </div>
            </fieldset>
          </div>
        )}
      </div>
    </div>
  );
}
