import { Suspense, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router';
import toast from '../ui/Toast';
import PageSkeleton from '../ui/PageSkeleton';
import { unfoldToAnchor } from '../../lib/unfoldToAnchor.js';
import useMusicVideoProductionReview from '../../hooks/useMusicVideoProductionReview.js';
import usePrevizJobs from '../../hooks/usePrevizJobs.js';
import useMusicVideoBlender from '../../hooks/useMusicVideoBlender.js';
import useHydratedPreviewRoute from '../../hooks/useHydratedPreviewRoute.js';
import {
  updateMusicVideoProject,
  keepMusicVideoSongTiming,
  musicVideoBlenderMediaUrl,
} from '../../services/apiMusicVideo.js';
import { normalizeImage, normalizeVideo } from '../media/normalize.js';
import { castAndSetsPreviewItems } from './CastAndSetsReferenceProgress.jsx';
import MediaPreview from '../media/MediaPreview.jsx';
import MusicVideoLayout from './MusicVideoLayout.jsx';
import ProjectManageActions from './ProjectManageActions.jsx';
import { SETTINGS_TAB_IDS } from './projectSettingsTabs.js';
import PreviewDock from './PreviewDock.jsx';
import NeedsAttentionBanner from './NeedsAttentionBanner.jsx';
import StageChecklist from './StageChecklist.jsx';
import { lazyWithReload } from '../../utils/lazyWithReload.js';
import useSetupStageWiring from './stages/useSetupStageWiring.js';
import useStoryStageWiring from './stages/useStoryStageWiring.js';
import useCastSetsStageWiring from './stages/useCastSetsStageWiring.js';
import usePlanStageWiring from './stages/usePlanStageWiring.js';
import useProduceStageWiring from './stages/useProduceStageWiring.js';
import useReviewStageWiring from './stages/useReviewStageWiring.js';
import usePublishStageWiring, { publishProgress } from './stages/usePublishStageWiring.js';
import { ownWrite } from '../../services/socketWriteOrigin.js';
import { videoPosterForJob } from '../../lib/creativeDirectorPreview.js';
import { sceneTakeList } from '../../lib/musicVideoTakes.js';
import { formatCount } from '../../utils/formatters.js';
import { deriveAttentionItems } from '../../lib/musicVideoAttention.js';
import { latestMusicVideoReviewDraft } from '../../../../server/lib/musicVideo/musicVideoReviewDraft.js';
import {
  deriveNextAction, deriveStages, describeProjectStatus, listPreviewSources, projectSpend, resolveStageParam, stageChecklist, stageHasChecklist, stepNotes, autopilotStatus, proofReviewInUse,
} from '../../lib/musicVideoStages.js';
import { blenderStillPreviewItems, summarizeBlenderShots } from '../../lib/musicVideoBlender.js';
import { shotStartFrameSec } from './ShotStepper.jsx';

// The step each production approval closes (#10151); it sits at the bottom of that step.
// Once the storyboard is approved, a production run parked on its pilot shows
// its optional animated proof there instead.
const APPROVAL_STAGE_BY_TAB = { 'cast-sets': 'art', produce: 'storyboard' };
const approvalStageFor = (tab, project, readiness, proofActive) => (tab === 'produce' && readiness?.storyboard?.approved
  ? (proofReviewInUse(project, readiness, { proofActive }) ? 'proof' : null)
  : APPROVAL_STAGE_BY_TAB[tab] || null);
// Steps reviewed by watching: the player leads them, with the approval beside it.
const PLAYER_FIRST_STAGES = new Set(['produce', 'review', 'editor']);
// Steps with no player: Assets is a contact sheet, Story and Plan are read and edited rather than watched.
const NO_DOCK_STAGES = new Set(['assets', 'story', 'board']);
// Each stage panel is its own chunk, fetched when its step first opens, so the
// project list and every other step never download it. The wiring hooks above
// stay static: they run for every step (checklists, notes, attention items).
// Panels and drawers that only render on one step or once opened load the same way, so the
// workspace's entry chunk carries just the shell every step shares.
const ProductionReviewPanel = lazyWithReload(() => import('./ProductionReviewPanel.jsx'));
const TitleCardPanel = lazyWithReload(() => import('./TitleCardPanel.jsx'));
const StatsOutroPanel = lazyWithReload(() => import('./StatsOutroPanel.jsx'));
const CreditsOutroPanel = lazyWithReload(() => import('./CreditsOutroPanel.jsx'));
const ContactSheetDrawer = lazyWithReload(() => import('./ContactSheetDrawer.jsx'));
const DevArtifactDrawer = lazyWithReload(() => import('./DevArtifactDrawer.jsx'));
const ProjectSettingsDrawer = lazyWithReload(() => import('./ProjectSettingsDrawer.jsx'));
const GalleryImagePicker = lazyWithReload(() => import('../imageGen/GalleryImagePicker.jsx'));
const GalleryVideoPicker = lazyWithReload(() => import('../videoGen/GalleryVideoPicker.jsx'));
const SetupStage = lazyWithReload(() => import('./stages/SetupStage.jsx'));
const StoryStage = lazyWithReload(() => import('./stages/StoryStage.jsx'));
const CastSetsStage = lazyWithReload(() => import('./stages/CastSetsStage.jsx'));
const PlanStage = lazyWithReload(() => import('./stages/PlanStage.jsx'));
const PrevizStage = lazyWithReload(() => import('./stages/PrevizStage.jsx'));
const ProduceStage = lazyWithReload(() => import('./stages/ProduceStage.jsx'));
const ReviewStage = lazyWithReload(() => import('./stages/ReviewStage.jsx'));
const PublishStage = lazyWithReload(() => import('./stages/PublishStage.jsx'));
const AssetsStage = lazyWithReload(() => import('./stages/AssetsStage.jsx'));
const CleanupStage = lazyWithReload(() => import('./stages/CleanupStage.jsx'));
const EditorStage = lazyWithReload(() => import('./stages/EditorStage.jsx'));
const stageFallback = <PageSkeleton header="none" label="Loading step" cards={3} sidebar={false} />;
// The editor lays the player out itself, beside the open shot and over the timeline.
const OWN_DOCK_STAGES = new Set(['editor']);
// The panels each stage tab renders (see lib/musicVideoStages.js for the ids).
const STAGE_VIEWS = {
  setup: SetupStage, story: StoryStage, 'cast-sets': CastSetsStage, board: PlanStage, previz: PrevizStage, produce: ProduceStage, review: ReviewStage, publish: PublishStage,
  assets: AssetsStage, cleanup: CleanupStage, editor: EditorStage,
};
// Rendered inside a stage's Suspense boundary, so its effect fires only once that panel has
// committed (a lazy panel commits after its chunk loads) and again whenever the kept-alive
// Story panel is shown again. Anchor links wait for it, or they would look for their target
// while the fallback is still on screen.
function StageReady({ stage, active, onReady }) {
  useEffect(() => { if (active) onReady(stage); }, [stage, active, onReady]);
  return null;
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
 *
 * This is the shell: the header, stage tabs, preview dock and drawers. Each
 * step's hooks and wiring live in its container under `stages/use*StageWiring.js`,
 * which returns the board keys that step reads.
 */
export default function ProjectWorkspace({
  selected, tracks, trackLibrary, trackName, youtube, separation, lyricAlign, midi, renderJob, videoSettings, publishing, analyzing, cloning,
  replaceProject, patchProject, patchScene, openProject, prepareSong, onAnalyze, onClone, onTrackImported,
  onRename, renameForm, deletion, unsavedSceneFields, takesRef, mergeFetchedProject, applyEdit, reloadOpenProject,
}) {
  const { projectId: routeProjectId, artifactId: routeArtifactId, stage: routeStage, sceneId: routeSceneId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedId = selected.id;
  const previzRunning = usePrevizJobs(selected).running.length > 0;

  const productionReview = useMusicVideoProductionReview({ project: selected, replaceProject, applyEdit, reloadOpenProject, takesRef });
  // A Blender film's renders live in its workspace, not on the record: one read per open project,
  // kept current over the socket. Held here so the step list knows how far the shots are and unsaved
  // edits in its panel survive a change of step.
  const blenderMode = selected.composition?.mode === 'blender';
  const blender = useMusicVideoBlender(selectedId, { enabled: blenderMode });
  const blenderState = blenderMode ? blender.state : null;
  // What the stage helpers read. The server puts `blenderShots` (how many shots have a current final
  // render) on the record it answers; the film state on this page is newer than that read, so the
  // same reading is recomputed from it as renders land.
  // The same goes for a final video left behind by a shot that changed or was rendered again.
  const stageProject = useMemo(
    () => (blenderState ? {
      ...selected, blenderShots: summarizeBlenderShots(blenderState.manifest?.shots, blenderState.renders),
      ...(blenderState.finalStale === true ? { renderDependencyState: { status: 'stale', reasons: ['Blender shots changed or were rendered again after this final was joined'] } } : {}),
    } : selected),
    [selected, blenderState],
  );
  const publish = publishProgress(publishing);
  const progress = deriveStages(stageProject, productionReview.readiness, publish);
  const autopilot = autopilotStatus(stageProject, productionReview.readiness, { progress });
  const notes = stepNotes(stageProject, productionReview.readiness, publish, { progress });
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
  // A shot's card lives on Shots, including links made when it lived on the Storyboard; the editor opens it in place.
  const sceneStage = resolveStageParam(routeStage) === 'editor' ? 'editor' : 'produce';
  const activeStage = routeSceneId ? sceneStage : (resolveStageParam(routeStage) || pinnedStage || progress.current);
  const storyVisited = useRef(false);
  if (activeStage === 'story') storyVisited.current = true;

  // The preview: scene cards and storyboard rows seek it. Steps reviewed by
  // watching put it first (open); elsewhere, below xl, it is a folded row until
  // the director opens it. `dockCollapsed` is null until they toggle it.
  const [seekRequest, setSeekRequest] = useState(null);
  const [dockCollapsed, setDockCollapsed] = useState(null);
  const [dockExpanded, setDockExpanded] = useState(false);
  // The preview's reading of the song's clock (`PreviewDock` fills it), which the editor's playhead follows.
  const songClockRef = useRef(null);
  // `play` starts playback from there (a storyboard row), `pause` stops it there; a scene card only cues the shot.
  const seekToScene = (scene, { play = false, pause = false } = {}) => {
    if (typeof scene?.startSec !== 'number') return;
    setSeekRequest((prev) => ({ t: shotStartFrameSec(scene.startSec), n: (prev?.n || 0) + 1, play, pause: !play && pause }));
  };

  // Lyric cues / phrases / pacing (#8964) and the typography manifest (#8984)
  // — optimistic-local + silent PATCH on blur, like the scene editors. Each PATCH replaces a whole list, so the
  // saves are chained: two quick blurs can never land out of order and let an
  // older snapshot of the list overwrite a newer one. Several steps edit these fields.
  const [compositionSavePending, setCompositionSavePending] = useState(0);
  const timedTextSaveChain = useRef(Promise.resolve());
  const editProjectLocal = (patch) => patchProject(selected.id, patch);
  // One project save from this tab, sent with its origin and asking for the edit result (`send(options)` gets
  // both): a reply with one patches the board and its own change broadcast is skipped, so the
  // save costs one request. A reply with `edit: null` wrote nothing. A take decision that started
  // meanwhile may be newer than the reply, and a refused (409) save may leave the board behind: both reload.
  const saveOwnEdit = (projectId, send) => {
    const mark = takesRef.current?.writeMark();
    return send(ownWrite({ edit: true })).then((reply) => {
      if (reply?.edit === null) return reply;
      if (reply?.edit && (!takesRef.current || takesRef.current.settledSince(mark))) applyEdit(projectId, reply.edit);
      else void reloadOpenProject(projectId);
      return reply;
    }, (err) => {
      if (err?.status === 409) void reloadOpenProject(projectId);
      throw err;
    });
  };
  const saveProjectFields = (patch) => {
    const projectId = selected.id;
    setCompositionSavePending((count) => count + 1);
    timedTextSaveChain.current = timedTextSaveChain.current
      .then(() => saveOwnEdit(projectId, (options) => updateMusicVideoProject(projectId, patch, options)))
      .catch((err) => { toast.error(err?.message || 'Failed to save changes'); return false; })
      .finally(() => setCompositionSavePending((count) => count - 1));
    return timedTextSaveChain.current;
  };
  // The finishing film look, saved whole from the image viewer's editor ("Use on project").
  const saveFilmLook = (filmLook) => saveProjectFields({ filmLook });

  // The render slot is page-wide; it gates this project's track change and header only while it renders this project.
  const renderTargetsSelected = !!(renderJob.active && selected && renderJob.context === selected.id);

  const review = useReviewStageWiring({ selected, replaceProject, activeStage });
  const setup = useSetupStageWiring({
    selected, tracks, midi, lyricAlign, renderTargetsSelected, replaceProject, openProject, prepareSong, navigate, onClone, saveOwnEdit,
  });
  const produce = useProduceStageWiring({
    selected, videoSettings, renderJob, productionReview, excerpts: review.excerpts, unsavedSceneFields, takesRef, mergeFetchedProject, applyEdit, reloadOpenProject,
    replaceProject, patchProject, patchScene, editProjectLocal, saveProjectFields, seekToScene, routeSceneId, navigate, sceneStage,
  });
  const castSetsStage = useCastSetsStageWiring({ selected, replaceProject, patchProject, productionReview, saveOwnEdit });
  const { castSets, devArtifacts, creativeSetupPending, styleReferencesPending } = castSetsStage;
  const story = useStoryStageWiring({ selected, patchProject, replaceProject });
  const plan = usePlanStageWiring({
    selected, replaceProject, analyzing, onAnalyze, separation, lyricAlign, castSets, creativeSetupPending, styleReferencesPending,
    applyEdit, reloadOpenProject, saveOwnEdit,
  });
  const { kickoff, autonomous, planning, planningDraft, autopilotBlockedReason } = plan;
  const { sceneMedia, takes, revisions, production } = produce;
  const { excerpts, autoReview, finalVideo, reviewingDraft, reviewDraftState } = review;

  // The one gallery picker on the page, aimed at either the visual spec's
  // references or one scene's frame takes. This workspace remounts per
  // project, so a picker opened for one project can never write into another.
  const [pickerTarget, setPickerTarget] = useState(null);
  const handlePickerSelect = (item) => {
    if (!item?.filename || !pickerTarget || !selected) return;
    if (pickerTarget.type === 'reference') {
      const references = selected.visualSpec?.references || [];
      if (references.some((ref) => ref.imageId === item.filename)) return;
      castSetsStage.saveVisualSpec({ references: [...references, { imageId: item.filename, role: 'mood', condition: false }] });
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
    // A Blender film's stills are workspace files, served by the film's media route.
    if (blenderState) items.push(...blenderStillPreviewItems(blenderState, (path) => musicVideoBlenderMediaUrl(selected.id, path)));
    // Scenes can reuse the same frame/clip (Make's generation controls surface a
    // "Repetition: N unique frames" badge). Dedupe by key so prev/next and
    // openPreview's .find() land on a single item rather than the first of
    // several identical keys with different prompts.
    return [...new Map(items.map((i) => [i.key, i])).values()];
  }, [selected, finalVideo.src, blenderState]);
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
  // The stage whose panel has committed. Landing waits for it so it runs exactly once per link:
  // a second pass would press a React-state fold toggle again and close what the first opened.
  const [readyStage, setReadyStage] = useState(null);
  useEffect(() => {
    const anchor = location.hash.slice(1);
    if (!anchor || !selected || readyStage !== activeStage) return;
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
  }, [activeStage, readyStage, location.key, selectedId, !!selected]);
  // Edit shot (from the preview player) opens that shot's card on Shots, in the side panel; in the editor, in its inspector.
  const editShot = (sceneId) => {
    if (!selected) return;
    const search = searchParams.toString();
    navigate(`/music-video/${encodeURIComponent(selected.id)}/${sceneStage}/scene/${encodeURIComponent(sceneId)}${search ? `?${search}` : ''}`, { replace: activeStage === sceneStage });
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

  const publishStage = usePublishStageWiring({
    selected, replaceProject, publishing, goToStage, creativeSetupPending, styleReferencesPending, compositionSavePending,
  });
  const { publishKit, publishBuildBlockedReason, buildPublishKit } = publishStage;

  const autopilotRun = selected?.autonomousRun || null;
  const productionNextAction = selected ? deriveNextAction(stageProject, {
    readiness: productionReview.readiness,
    publish,
    progress,
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
  const reviewDraft = reviewDraftState.draft;
  const nextAction = reviewingDraft ? reviewDraftState.checking
    ? { id: 'review-imported', kind: 'goto', stage: 'review', label: 'Checking review draft', disabled: true, reason: 'Checking exact-version media availability' }
    : reviewDraft
      ? { id: 'review-imported', kind: 'goto', stage: 'review', label: 'Review imported draft', shortLabel: 'Review draft' }
      : { id: 'review-files', kind: 'open', label: 'Choose review file', shortLabel: 'Choose file' }
    : productionNextAction?.id === 'build-publish-kit' && (publishKit.building || publishBuildBlockedReason)
      ? { ...productionNextAction, disabled: true, ...(publishKit.building ? { label: 'Building publishing kit…' } : { reason: publishBuildBlockedReason }) }
      : productionNextAction;
  // What the server holds that this tab might not be showing (#9940): derived
  // from the saved record, so it survives a reload. Work this tab can see
  // progressing (spinning sections, an attached render) is not flagged.
  const attentionItems = selected ? deriveAttentionItems(stageProject, {
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
    if (action.run === 'build-publish-kit') { buildPublishKit(); return; }
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
    if (nextAction.id === 'build-publish-kit') { buildPublishKit(); return; }
    if (nextAction.kind === 'goto') { goToStage(nextAction.stage, nextAction.anchor); return; }
    switch (nextAction.id) {
      case 'kickoff': plan.handleKickoff(); break;
      case 'analyze': onAnalyze(); break;
      case 'plan': plan.handlePlan(); break;
      case 'approve-cast-sets': plan.approveCastAndSets(); break;
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
      <Suspense fallback={null}>
      <TitleCardPanel project={selected} onEditLocal={editProjectLocal} onSave={saveProjectFields}
        onPreview={(startSec) => seekToScene({ startSec }, { play: true })} />
      <StatsOutroPanel project={selected} onEditLocal={editProjectLocal} onSave={saveProjectFields} />
      <CreditsOutroPanel project={selected} onEditLocal={editProjectLocal} onSave={saveProjectFields} />
      </Suspense>
    </div>
  ));
  const board = selected ? {
    ...setup.board,
    ...story.board,
    ...castSetsStage.board,
    ...plan.board,
    ...produce.board,
    ...review.board,
    ...publishStage.board,
    // Carries the live `blenderShots` for a Blender film, so every panel reads the same step state as the header.
    project: stageProject,
    blender: blenderMode ? blender : null,
    onEditShot: editShot,
    autopilotRun,
    productionReadiness: productionReview.readiness,
    onRevertApproval: productionReview.revert,
    locked: creativeSetupPending || styleReferencesPending || compositionSavePending > 0,
    busy: { analyzing, planning, arranging: plan.arranging, cloning },
    tracks,
    trackLibrary,
    trackName,
    youtube,
    separation,
    midi,
    renderBound: renderTargetsSelected,
    videoSettings,
    renderJob,
    replaceProject,
    editProjectLocal,
    saveProjectFields,
    saveMediaMode: (mediaMode) => saveProjectFields({ mediaMode }),
    setPickerTarget,
    onAddReference: () => setPickerTarget({ type: 'reference' }),
    onAnalyze: () => onAnalyze(),
    onTrackImported,
    onUploadArtifact: (file, fields) => devArtifacts.upload(file, fields).then((res) => {
      if (res?.artifact) openArtifact(res.artifact.id);
    }),
    goToStage,
    openSettings: setSettingsTab,
    productionReview,
    openArtifact,
    openPreview,
    openContactSheet: () => setContactSheetOpen(true),
    seekToScene,
  } : null;
  const StageView = STAGE_VIEWS[activeStage];
  const playerFirst = PLAYER_FIRST_STAGES.has(activeStage);
  const projectStatus = !selected ? null : statusKnown && productionReview.readiness
    ? describeProjectStatus(stageProject, { progress, nextAction: productionNextAction, reviewingDraft, reviewDraftState })
    : statusKnown
      ? { headline: `Status unavailable: ${productionReview.readinessError}`, tone: 'warn', needsYouStage: null }
      : { headline: 'Loading status…', tone: 'muted', needsYouStage: null };

  // Explicit proof links must stay reachable even when no production run needs
  // proof approval (including an already-approved or stale registered proof).
  const proofRequested = activeStage === 'produce' && ['#mv-review-proof', '#mv-review-render'].includes(location.hash);
  const reviewStage = selected ? (proofRequested ? 'proof' : approvalStageFor(activeStage, selected, productionReview.readiness, productionReview.proof.active)) : null;
  // `stageProject`: a Blender film's live composite is offered once the film state lists synced shots.
  const previewSources = selected ? listPreviewSources(stageProject, { finalVideoSrc: finalVideo.src, leadWith: activeStage === 'review' ? 'drafts' : ['produce', 'editor'].includes(activeStage) ? 'storyboard' : activeStage === 'setup' ? 'lyrics' : activeStage === 'previz' ? 'previz' : 'final' }) : [];

  const dock = !selected || NO_DOCK_STAGES.has(activeStage) ? null : (
    <PreviewDock
      project={selected}
      sources={previewSources}
      audioUrl={setup.audioUrl}
      seekRequest={seekRequest}
      collapsed={dockCollapsed ?? !playerFirst}
      onToggleCollapsed={() => setDockCollapsed(!(dockCollapsed ?? !playerFirst))}
      expanded={dockExpanded}
      onToggleExpanded={!playerFirst ? () => setDockExpanded((expanded) => !expanded) : undefined}
      onEditShot={editShot}
      onProject={replaceProject}
      blender={blenderMode ? blender : null}
      clockRef={songClockRef}
      compact={OWN_DOCK_STAGES.has(activeStage)}
      controlsBeside={OWN_DOCK_STAGES.has(activeStage)}
    />
  );
  const ownDock = OWN_DOCK_STAGES.has(activeStage);

  return (
    <>
      <MediaPreview preview={preview} setPreview={setPreview} items={previewItems}
        filmLookProject={selected ? { look: selected.filmLook, name: selected.name, onSave: saveFilmLook } : null} />
      <Suspense fallback={null}>
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
          allowUpload
          uploadToGallery
        />
      )}
      {routeArtifactId && <DevArtifactDrawer
          key={routeArtifactId || 'none'}
          open={!!routeArtifactId}
          onClose={closeArtifact}
          project={selected}
          artifact={openArtifactRecord}
          version={artifactVersion}
          onVersionChange={setArtifactVersion}
          ops={devArtifacts}
          busy={devArtifacts.busy || castSets.busy}
          castAndSets={{ regenerate: () => castSets.regenerate(), approveAndContinue: plan.approveCastAndSets }}
        />}
      {contactSheetOpen && <ContactSheetDrawer
          open={contactSheetOpen}
          onClose={() => setContactSheetOpen(false)}
          project={selected}
          busy={takes.busy}
          saving={takes.pending}
          onSelectTake={takes.selectTake}
          onReviewTake={takes.reviewTake}
          onOpenPreview={openPreview}
          pendingOnly={contactSheetPendingOnly}
          onPendingOnlyChange={setContactSheetPendingOnly}
          onRegenerateFrame={sceneMedia.generateFrame}
          generatingScenes={sceneMedia.genScenes}
        />}
      </Suspense>
          {settingsTab && <Suspense fallback={null}><ProjectSettingsDrawer open={!!settingsTab} tab={settingsTab || 'project'} onTabChange={setSettingsTab} onClose={() => setSettingsTab(null)}
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
          /></Suspense>}
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
            notes={previzRunning ? { ...notes, previz: 'Running…' } : notes}
            autopilot={autopilot}
            onOpenSettings={openHeaderSettings}
            playerFirst={playerFirst}
            previewExpanded={dockExpanded}
            onRename={onRename}
            renameForm={renameForm}
            cancelRender={renderTargetsSelected && !renderJob.pending ? { onCancel: renderJob.cancel, cancelling: renderJob.cancelling } : null}
            lead={stageHasChecklist(activeStage) ? (
              <StageChecklist
                items={stageChecklist(activeStage, stageProject, productionReview.readiness, publish).map((item) => publishBuildBlockedReason && item.action?.run === 'build-publish-kit'
                  ? { ...item, detail: publishBuildBlockedReason, action: { ...item.action, disabled: true, reason: publishBuildBlockedReason } } : item)}
                onAction={runChecklistAction}
                busy={castSets.busy || productionReview.busy || publishKit.building}
                onRevert={productionReview.revert}
                headerAnchor={nextAction?.kind === 'goto' ? nextAction.anchor : null}
              />
            ) : null}
            review={reviewStage ? (
              <Suspense fallback={null}><ProductionReviewPanel
                key={`${selected.id}-${activeStage}`}
                project={selected}
                review={productionReview}
                onOpenArtifact={openArtifact}
                stage={reviewStage}
                planning={planningDraft}
                onNavigate={goToStage}
                onSeek={(startSec) => seekToScene({ startSec }, { play: true })}
              /></Suspense>
            ) : null}
            attention={(
              <>
              {takes.reconcileError && <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-port-warning/40 p-2 text-xs"><p className="text-port-warning">Take changes could not be confirmed: {takes.reconcileError.message}. Reload the saved decisions before relying on this selection.</p><button type="button" className="min-h-[44px] rounded border border-port-border px-2 disabled:opacity-50 pointer-fine:sm:min-h-0" disabled={takes.reconciling} onClick={takes.retryReconcile}>{takes.reconciling ? 'Reloading saved takes…' : 'Retry saved takes'}</button></div>}
              <NeedsAttentionBanner
                // A parked autonomous or production run with nothing to resume, while the
                // header's Autopilot button reports that run, is that button (which opens it); no second row.
                items={autopilot.label === 'Autopilot' ? attentionItems
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
                  onRefreshSong: () => prepareSong(selected.id, { refresh: true }),
                  onKeepSongTiming: () => keepMusicVideoSongTiming(selected.id).then(replaceProject),
                }}
              />
              </>
            )}
            dock={dock && !ownDock ? withTitleCard(dock) : null}
          >
            {storyVisited.current && <div hidden={activeStage !== 'story'}><Suspense fallback={stageFallback}><StoryStage board={board} active={activeStage === 'story'} /><StageReady stage="story" active={activeStage === 'story'} onReady={setReadyStage} /></Suspense></div>}
            {activeStage !== 'story' && (
              <Suspense fallback={stageFallback}>
                <StageView board={ownDock ? { ...board, previewDock: dock, songClock: () => songClockRef.current?.() ?? null } : board} />
                <StageReady key={activeStage} stage={activeStage} active onReady={setReadyStage} />
              </Suspense>
            )}
          </MusicVideoLayout>
    </>
  );
}
