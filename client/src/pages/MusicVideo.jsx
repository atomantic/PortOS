import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Plus, Film } from 'lucide-react';
import toast from '../components/ui/Toast';
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
  reorderMusicVideoScenes,
} from '../services/apiMusicVideo.js';
import useFieldDraft from '../hooks/useFieldDraft.js';
import useMusicVideoYoutubeImport from '../hooks/useMusicVideoYoutubeImport.js';
import useMusicVideoMidiJob from '../hooks/useMusicVideoMidiJob.js';
import useMusicVideoRenderJob from '../hooks/useMusicVideoRenderJob.js';
import useMusicVideoModelSettings from '../hooks/useMusicVideoModelSettings.js';
import useMusicVideoManualTempo from '../hooks/useMusicVideoManualTempo.js';
import useMusicVideoSceneMedia from '../hooks/useMusicVideoSceneMedia.js';
import usePreviewRoute from '../hooks/usePreviewRoute.js';
import { useVideoFileSrc } from '../hooks/useVideoFileSrc.js';
import MediaPreview from '../components/media/MediaPreview.jsx';
import MidiInstallModal from '../components/install/MidiInstallModal.jsx';
import MidiGatedModal from '../components/install/MidiGatedModal.jsx';
import { listTracks } from '../services/apiTracks.js';
import BeatTimeline from '../components/musicVideo/BeatTimeline.jsx';
import CreateProjectDrawer from '../components/musicVideo/CreateProjectDrawer.jsx';
import ProjectToolbar from '../components/musicVideo/ProjectToolbar.jsx';
import TrackPanel from '../components/musicVideo/TrackPanel.jsx';
import RenderStatusPanel from '../components/musicVideo/RenderStatusPanel.jsx';
import AnalysisPanel from '../components/musicVideo/AnalysisPanel.jsx';
import SceneCard from '../components/musicVideo/SceneCard.jsx';
import { autoArrangeScenes } from '../lib/beatGrid.js';
import { isLtx2FamilyRuntime } from '../lib/runnerFamilies';
import { videoSrcForJob, videoPosterForJob } from '../lib/creativeDirectorPreview.js';

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
  const selectedId = routeProjectId || null;
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', mode: 'director', trackId: '' });
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
  const videoSettings = useMusicVideoModelSettings({ project: selected, onProjectPatch: patchProject });
  const tempo = useMusicVideoManualTempo({ project: selected, onUpdated: replaceProject });
  const sceneMedia = useMusicVideoSceneMedia({
    project: selected,
    videoSettings,
    applyScenePatch: patchScene,
  });

  // The in-flight render already resolved the project's audio at kickoff;
  // relinking the track now would leave the project pointing at a NEW track
  // while the video that finishes rendering was produced from the OLD one.
  const renderTargetsSelected = !!(renderJob.job && selected && renderJob.job.projectId === selected.id);
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
    createMusicVideoProject({ name: form.name.trim(), mode: form.mode, trackId: form.trackId || null }, { silent: true })
      .then((proj) => {
        setProjects((prev) => [...prev, proj]);
        selectProject(proj.id);
        setForm({ name: '', mode: 'director', trackId: '' });
        setCreateOpen(false);
        toast.success('Project created');
      })
      .catch((err) => toast.error(err?.message || 'Failed to create project'));
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

  const handleAnalyze = () => {
    if (!selected) return;
    setAnalyzing(true);
    analyzeMusicVideoProject(selected.id, { silent: true })
      .then((proj) => { replaceProject(proj); toast.success(`Analyzed — ${proj.audioAnalysis?.bpm ? `${proj.audioAnalysis.bpm} BPM` : 'no tempo detected'}`); })
      .catch((err) => toast.error(err?.message || 'Analysis failed'))
      .finally(() => setAnalyzing(false));
  };

  // Autonomous shot planner (#1855): propose one scene per analyzed audio
  // section (energy-aware durations fall out of the section boundaries
  // themselves) and seed them onto the board, optionally with a first-pass
  // framePrompt/prompt per scene. Director-first — seeded scenes are
  // ordinary, fully-editable board entries, same as a hand-added one.
  const handlePlan = () => {
    if (!selected?.audioAnalysis) return;
    setPlanning(true);
    planMusicVideoProject(selected.id, { seedPrompts: true }, { silent: true })
      .then(({ project, scenesAdded, promptsSeeded, promptsSkippedReason }) => {
        replaceProject(project);
        const suffix = promptsSeeded
          ? ' with first-pass prompts'
          : (promptsSkippedReason && promptsSkippedReason !== 'not-requested' ? ` (prompts skipped: ${promptsSkippedReason})` : '');
        toast.success(`Planned ${scenesAdded} scene${scenesAdded === 1 ? '' : 's'}${suffix}`);
      })
      .catch((err) => toast.error(err?.message || 'Plan failed'))
      .finally(() => setPlanning(false));
  };

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

  const handleDeleteScene = (sceneId) => {
    deleteMusicVideoScene(selected.id, sceneId, { silent: true })
      .then((proj) => replaceProject(proj))
      .catch((err) => toast.error(err?.message || 'Failed to delete scene'));
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
  // scene's frame then clip in board order. Keys use the canonical
  // `image:<filename>` / `video:<historyId>` shape from media/normalize so the
  // lightbox's always-mounted Add-to-collection / Pin-to-moodboard menus get a
  // real `id`/`filename` ref (same vocabulary as Media History's ?preview=).
  const previewItems = useMemo(() => {
    if (!selected) return [];
    const items = [];
    if (selected.renderHistoryId && finalVideo.src) {
      items.push({
        key: `video:${selected.renderHistoryId}`,
        kind: 'video',
        id: selected.renderHistoryId,
        filename: finalVideo.src.split('/').pop() || selected.renderHistoryId,
        downloadUrl: finalVideo.src,
        previewUrl: videoPosterForJob(selected.renderHistoryId),
        prompt: `Music Video: ${selected.name}`,
      });
    }
    for (const scene of selected.scenes || []) {
      if (scene.referenceImageId) {
        const imgUrl = `/data/images/${scene.referenceImageId}`;
        items.push({
          key: `image:${scene.referenceImageId}`,
          kind: 'image',
          filename: scene.referenceImageId,
          previewUrl: imgUrl,
          downloadUrl: imgUrl,
          prompt: scene.framePrompt || scene.prompt || '',
        });
      }
      if (scene.videoHistoryId) {
        items.push({
          key: `video:${scene.videoHistoryId}`,
          kind: 'video',
          id: scene.videoHistoryId,
          filename: `${scene.videoHistoryId}.mp4`,
          downloadUrl: videoSrcForJob(scene.videoHistoryId),
          previewUrl: videoPosterForJob(scene.videoHistoryId),
          prompt: scene.prompt || '',
        });
      }
    }
    // Scenes can reuse the same frame/clip (ProjectToolbar surfaces a
    // "Repetition: N unique frames" badge). Dedupe by key so prev/next and
    // openPreview's .find() land on a single item rather than the first of
    // several identical keys with different prompts.
    return [...new Map(items.map((i) => [i.key, i])).values()];
  }, [selected, finalVideo.src]);
  const [preview, setPreview] = usePreviewRoute(previewItems);
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
      <PageHeader icon={Film} title="Music Video" subtitle="Director-controlled, beat-aware music videos" />

      <CreateProjectDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        form={form}
        onFormChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        tracks={tracks}
        trackName={trackName}
        youtube={youtube}
        onSubmit={handleCreate}
      />

      <div className="bg-port-card border border-port-border rounded-lg p-3 flex flex-wrap items-center gap-2">
        <label htmlFor="mv-project-picker" className="text-xs text-port-text-muted">Project</label>
        <select
          id="mv-project-picker"
          value={selectedId || ''}
          onChange={(e) => selectProject(e.target.value || null)}
          disabled={loading || youtube.editJob.active}
          className="min-w-0 flex-1 sm:max-w-md bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm disabled:opacity-50"
        >
          <option value="">{loading ? 'Loading projects…' : 'Select a project…'}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name} · {project.scenes?.length || 0} scenes · {project.status}
            </option>
          ))}
        </select>
        {selected && (
          <>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-port-border">
              v{selected.version || 1}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLORS[selected.status] || 'bg-port-border'}`}>
              {selected.status}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1 bg-port-accent text-white rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0"
        >
          <Plus size={15} /> New project
        </button>
      </div>

      <div>
        {!selected && !loading && routeProjectId && (
          <p className="text-sm text-port-text-muted">
            Project not found — it may have been deleted.{' '}
            <button onClick={() => navigate('/music-video')} className="text-port-accent underline">Back to projects</button>
          </p>
        )}
        {!selected && (loading || !routeProjectId) && (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center">
            <p className="text-sm text-port-text-muted">Select a project above or create one to open its scene board.</p>
          </div>
        )}
        {selected && (
          <div className="space-y-3">
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
                onPlan={handlePlan}
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
                  <textarea
                    id="mv-concept"
                    value={conceptDraft.value}
                    rows={2}
                    maxLength={8000}
                    onChange={conceptDraft.onChange}
                    onBlur={conceptDraft.onBlur}
                    placeholder="What is this video about — story, theme, or narrative thread for the AI plan to build on."
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="mv-style" className="block text-xs text-port-text-muted mb-1">Visual style</label>
                  <textarea
                    id="mv-style"
                    value={styleDraft.value}
                    rows={2}
                    maxLength={2000}
                    onChange={styleDraft.onChange}
                    onBlur={styleDraft.onBlur}
                    placeholder="Art style, references, palette, mood — appended to every generated frame and shot prompt."
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
                  />
                </div>
              </div>
              <TrackPanel
                project={selected}
                tracks={tracks}
                trackName={trackName}
                audioFilename={projectAudioFilename(selected)}
                youtube={youtube}
                renderBound={renderTargetsSelected}
                midiBound={midiTargetsSelected}
                onChangeTrack={handleChangeTrack}
              />
              <RenderStatusPanel
                rendering={!!renderJob.job}
                progress={renderJob.progress}
                renderHistoryId={selected.renderHistoryId}
                finalVideo={finalVideo}
                onOpenPreview={openPreview}
              />
              <AnalysisPanel
                audioAnalysis={selected.audioAnalysis}
                scenes={selected.scenes || []}
                tempo={tempo}
              />
            </div>

            {selected.audioAnalysis && (selected.scenes || []).length > 0 && (
              <BeatTimeline audioAnalysis={selected.audioAnalysis} scenes={selected.scenes} onCommit={commitSceneTiming} />
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
                  canContinueShot={canContinueShot}
                  onMove={moveScene}
                  onDelete={handleDeleteScene}
                  onEditLocal={editSceneLocal}
                  onSave={saveScene}
                  onGenerateFrame={sceneMedia.generateFrame}
                  onGenerateVideo={sceneMedia.generateSceneVideo}
                  onContinueVideo={sceneMedia.continueSceneVideo}
                  onOpenPreview={openPreview}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
