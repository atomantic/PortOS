import { Suspense, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import PageSkeleton from '../ui/PageSkeleton';
import useMusicVideoProductionReview from './useMusicVideoProductionReview.js';
import usePrevizJobs from '../../hooks/usePrevizJobs.js';
import useMusicVideoBlender from '../../hooks/useMusicVideoBlender.js';
import useHydratedPreviewRoute from '../../hooks/useHydratedPreviewRoute.js';
import MediaPreview from '../media/MediaPreview.jsx';
import MusicVideoLayout from './MusicVideoLayout.jsx';
import { lazyWithReload } from '../../utils/lazyWithReload.js';
import useSetupStageWiring from './stages/useSetupStageWiring.js';
import useStoryStageWiring from './stages/useStoryStageWiring.js';
import useCastSetsStageWiring from './stages/useCastSetsStageWiring.js';
import usePlanStageWiring from './stages/usePlanStageWiring.js';
import useProduceStageWiring from './stages/useProduceStageWiring.js';
import useReviewStageWiring from './stages/useReviewStageWiring.js';
import usePublishStageWiring, { publishProgress } from './stages/usePublishStageWiring.js';
import { deriveStages, describeProjectStatus, projectSpend, stageHasChecklist, stepNotes, autopilotStatus, proofReviewInUse } from '../../lib/musicVideoStages.js';
import { summarizeBlenderShots } from '../../lib/musicVideoBlender.js';
import { shotStartFrameSec } from './ShotStepper.jsx';
import buildMusicVideoPreviewItems from './buildMusicVideoPreviewItems.js';
import useMusicVideoWorkspaceActions from './useMusicVideoWorkspaceActions.js';
import useMusicVideoWorkspaceNavigation from './useMusicVideoWorkspaceNavigation.js';
import buildMusicVideoStageActions from './buildMusicVideoStageActions.js';
import WorkspaceAttention from './WorkspaceAttention.jsx';
import WorkspacePreviewDock from './WorkspacePreviewDock.jsx';

import WorkspaceDrawers from './WorkspaceDrawers.jsx';
import WorkspaceStageChecklist from './WorkspaceStageChecklist.jsx';

function workspaceStatus(project, productionReview, options) {
  if (productionReview.readiness) return describeProjectStatus(project, options);
  if (productionReview.readinessError) return { headline: `Status unavailable: ${productionReview.readinessError}`, tone: 'warn', needsYouStage: null };
  return { headline: 'Loading status…', tone: 'muted', needsYouStage: null };
}

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
  onRename, renameForm, versionPicker, deletion, unsavedSceneFields, takesRef, mergeFetchedProject, applyEdit, reloadOpenProject,
}) {
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
  const statusKnown = !!productionReview.readiness || !!productionReview.readinessError;
  const navigation = useMusicVideoWorkspaceNavigation({ selected, statusKnown, progress });
  const { routeSceneId, sceneStage, activeStage, navigate, setReadyStage, editShot, goToStage, setSettingsTab, setContactSheetOpen, openArtifact, location, openHeaderSettings } = navigation;
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
  // The workspace is keyed by project. Keep the range across stage changes in that session.
  const [editorRange, setEditorRange] = useState(null);
  const seekInSong = (t, { play = false, pause = false, songOnly = false } = {}) => {
    setSeekRequest((prev) => ({ t, n: (prev?.n || 0) + 1, play, pause: !play && pause, songOnly }));
  };
  // `play` starts playback from there (a storyboard row), `pause` stops it there; a scene card only cues the shot.
  const seekToScene = (scene, options) => {
    if (typeof scene?.startSec !== 'number') return;
    seekInSong(shotStartFrameSec(scene.startSec), options);
  };

  const { compositionSavePending, editProjectLocal, saveOwnEdit, saveProjectFields, saveFilmLook } = useMusicVideoWorkspaceActions({
    selected, patchProject, applyEdit, reloadOpenProject, takesRef,
  });

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
  const { planning, planningDraft } = plan;
  const { finalVideo, reviewingDraft, reviewDraftState } = review;

  // The one gallery picker on the page, aimed at either the visual spec's
  // references or one scene's frame takes. This workspace remounts per
  // project, so a picker opened for one project can never write into another.
  const [pickerTarget, setPickerTarget] = useState(null);
  const previewItems = useMemo(() => buildMusicVideoPreviewItems(selected, finalVideo.src, blenderState), [selected, finalVideo.src, blenderState]);
  const [preview, setPreview] = useHydratedPreviewRoute(previewItems);
  const openPreview = useCallback((key) => {
    if (!key) return;
    const match = previewItems.find((i) => i.key === key);
    if (match) setPreview(match);
  }, [previewItems, setPreview]);

  const publishStage = usePublishStageWiring({
    selected, replaceProject, publishing, goToStage, creativeSetupPending, styleReferencesPending, compositionSavePending,
  });

  const autopilotRun = selected?.autonomousRun || null;
  const { nextAction, productionNextAction, attentionItems, runChecklistAction, runNextAction,
    keepApproval } = buildMusicVideoStageActions({
    selected, stageProject, productionReview, publish, progress, renderTargetsSelected,
    review, plan, renderJob, analyzing, publishStage, produce, activeStage, castSets,
    navigation,
    compositionSavePending, onAnalyze,
  });

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
      <CreditsOutroPanel project={selected} onEditLocal={editProjectLocal} onSave={saveProjectFields} showPreview />
      </Suspense>
    </div>
  ));
  const board = {
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
  };
  const StageView = STAGE_VIEWS[activeStage];
  const playerFirst = PLAYER_FIRST_STAGES.has(activeStage);
  const projectStatus = workspaceStatus(stageProject, productionReview, { progress, nextAction: productionNextAction, reviewingDraft, reviewDraftState });

  // Explicit proof links must stay reachable even when no production run needs
  // proof approval (including an already-approved or stale registered proof).
  const proofRequested = activeStage === 'produce' && ['#mv-review-proof', '#mv-review-render'].includes(location.hash);
  const reviewStage = proofRequested ? 'proof' : approvalStageFor(activeStage, selected, productionReview.readiness, productionReview.proof.active);
  const ownDock = OWN_DOCK_STAGES.has(activeStage);
  const dock = NO_DOCK_STAGES.has(activeStage) ? null : (
    <WorkspacePreviewDock selected={selected} stageProject={stageProject} finalVideo={finalVideo} activeStage={activeStage}
        setup={setup} seekRequest={seekRequest} dockCollapsed={dockCollapsed}
        setDockCollapsed={setDockCollapsed} dockExpanded={dockExpanded} setDockExpanded={setDockExpanded}
        playerFirst={playerFirst} editShot={editShot} replaceProject={replaceProject}
        songClockRef={songClockRef} blender={blenderMode ? blender : null} compact={ownDock} />
  );

  return (
    <>
      <MediaPreview preview={preview} setPreview={setPreview} items={previewItems}
        filmLookProject={{ look: selected.filmLook, name: selected.name, onSave: saveFilmLook }} />
      <WorkspaceDrawers selected={selected} navigation={navigation} board={board} castSetsStage={castSetsStage}
        produce={produce} plan={plan} pickerTarget={pickerTarget} setPickerTarget={setPickerTarget}
        openPreview={openPreview} cloning={cloning} onClone={onClone} deletion={deletion} />
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
          versionPicker={versionPicker}
          cancelRender={renderTargetsSelected && !renderJob.pending ? { onCancel: renderJob.cancel, cancelling: renderJob.cancelling } : null}
          lead={stageHasChecklist(activeStage) ? (
            <WorkspaceStageChecklist activeStage={activeStage} stageProject={stageProject} productionReview={productionReview}
      publish={publish} publishStage={publishStage} castSets={castSets}
      runChecklistAction={runChecklistAction} nextAction={nextAction} />
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
            <WorkspaceAttention selected={selected} prepareSong={prepareSong} replaceProject={replaceProject} autopilot={autopilot}
      attentionItems={attentionItems} renderJob={renderJob} productionReview={productionReview}
      castSets={castSets} review={review} produce={produce} plan={plan} keepApproval={keepApproval} />
          )}
          dock={dock && !ownDock ? withTitleCard(dock) : null}
        >
          {storyVisited.current && <div hidden={activeStage !== 'story'}><Suspense fallback={stageFallback}><StoryStage board={board} active={activeStage === 'story'} /><StageReady stage="story" active={activeStage === 'story'} onReady={setReadyStage} /></Suspense></div>}
          {activeStage !== 'story' && (
            <Suspense fallback={stageFallback}>
              <StageView board={ownDock ? { ...board, previewDock: dock, seekInSong, editorRange, setEditorRange, songClock: () => songClockRef.current?.() ?? null } : board} />
              <StageReady key={activeStage} stage={activeStage} active onReady={setReadyStage} />
            </Suspense>
          )}
        </MusicVideoLayout>
    </>
  );
}
