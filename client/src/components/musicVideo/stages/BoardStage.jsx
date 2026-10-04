import { Plus } from 'lucide-react';
import BeatTimeline from '../BeatTimeline.jsx';
import ContactSheetButton from '../ContactSheetButton.jsx';
import SceneCard from '../SceneCard.jsx';
import { PlanActions } from '../ProjectActionGroups.jsx';
import { isLayeredComposition } from '../../../lib/musicVideoLayers.js';

/**
 * Board: plan and arrange the shots, the beat timeline, and the scene cards —
 * one column on a phone, two and three as the column widens (a container
 * query, so the docked preview narrowing the column is accounted for). Cards
 * are collapsed to a thumbnail, lyric and status until tapped.
 */
export default function BoardStage({ board }) {
  const { project, locked, busy, sceneMedia, videoSettings, takes, activeSceneId, onToggleSceneExpand } = board;
  const scenes = project.scenes || [];
  const performanceReviews = new Map();
  const attempts = (project.autoReviews || []).flatMap((run) => run.attempts || []).slice().reverse();
  for (const attempt of attempts) {
    const temporal = attempt.review?.evidence?.temporal;
    for (const shot of temporal?.shots || []) {
      const key = `${shot.sceneId}:${shot.takeId}`;
      if (!performanceReviews.has(key)) performanceReviews.set(key, {
        shot: { ...shot, status: attempt.review.dependencyState?.status === 'current' ? temporal.status : 'unverified', lipSync: attempt.review.checks?.lipSync, analyzer: temporal.analyzer },
        excerptStartSec: attempt.review.evidence.excerptStartSec,
        excerptId: attempt.excerptId,
      });
    }
  }
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      <div className="rounded-lg border border-port-border bg-port-card p-3">
        <PlanActions project={project} busy={busy} onPlan={board.onPlan} onAutoArrange={board.onAutoArrange} />
      </div>

      {project.audioAnalysis && scenes.length > 0 && (
        <BeatTimeline audioAnalysis={project.audioAnalysis} scenes={scenes} lyricCues={project.lyricCues} narrativeEvents={project.composition?.narrativeEvents}
          onSeek={(startSec) => board.seekToScene({ startSec })} onCommit={board.commitSceneTiming} />
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Scene board</h3>
        <div className="flex items-center gap-2">
          <ContactSheetButton onOpen={board.openContactSheet} />
          <button onClick={board.onAddScene} className="flex min-h-[44px] items-center gap-1 rounded bg-port-accent px-2 py-1.5 text-sm text-white sm:min-h-0">
            <Plus size={15} /> Add scene
          </button>
        </div>
      </div>

      {scenes.length === 0 && <p className="text-sm text-port-text-muted">No scenes yet — add one to start the board.</p>}
      <div className="@container">
        <div className="grid grid-cols-1 items-start gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {scenes.map((scene, idx) => (
            <SceneCard
              key={scene.sceneId}
              scene={scene}
              expanded={activeSceneId === scene.sceneId}
              onToggleExpand={onToggleSceneExpand}
              performanceReview={performanceReviews.get(`${scene.sceneId}:${scene.videoHistoryId}`)}
              index={idx}
              isLast={idx === scenes.length - 1}
              generatingFrame={sceneMedia.genScenes[scene.sceneId]}
              generatingVideo={sceneMedia.genVideoScenes[scene.sceneId]}
              settingsSaving={videoSettings.saving}
              videoBlockedReason={videoSettings.videoBlockedReason}
              lipSyncBackend={videoSettings.audioReactiveSelected ? 'local' : videoSettings.settings.backend}
              songDurationSec={project.audioAnalysis?.durationSec ?? null}
              falVideoSettings={videoSettings.settings}
              canContinueShot={board.canContinueShot}
              onMove={board.moveScene}
              onDelete={board.onDeleteScene}
              onSplit={board.onSplitScene}
              onRepairPerformance={['code', 'document'].includes(project.composition?.mode) ? null : board.onRepairPerformance}
              repairBusy={board.repairBusy || videoSettings.saving}
              onEditLocal={board.editSceneLocal}
              onSave={board.saveScene}
              onGenerateFrame={sceneMedia.generateFrame}
              onGenerateVideo={sceneMedia.generateSceneVideo}
              onContinueVideo={sceneMedia.continueSceneVideo}
              onOpenPreview={board.openPreview}
              onSeek={board.seekToScene}
              takeBusy={takes.busy}
              onSelectTake={takes.selectTake}
              onReviewTake={takes.reviewTake}
              onImportTake={(target) => board.setPickerTarget({ type: 'take', sceneId: target.sceneId })}
              onImportClipTake={(target) => board.setPickerTarget({ type: 'clip', sceneId: target.sceneId })}
              layered={isLayeredComposition(project)}
            />
          ))}
        </div>
      </div>
    </fieldset>
  );
}
