import { useEffect, useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { Plus, Image as ImageIcon } from 'lucide-react';
import BeatTimeline from '../BeatTimeline.jsx';
import ContactSheetButton from '../ContactSheetButton.jsx';
import SceneCard from '../SceneCard.jsx';
import TreatmentPanel, { treatmentSummary } from '../TreatmentPanel.jsx';
import StageSection from '../StageSection.jsx';
import { PlanActions } from '../ProjectActionGroups.jsx';
import ShotPacingFields from '../ShotPacingFields.jsx';
import { isLayeredComposition } from '../../../lib/musicVideoLayers.js';
import { FOOTAGE_OPTIONAL_MODES } from '../../../lib/musicVideoStages.js';
import { parseSceneFilter, sceneAttention, sceneMatchesFilter, SCENE_ATTENTION_LABELS } from '../../../lib/musicVideoSceneAttention.js';
import { musicVideoImageSrc } from '../../../lib/musicVideoPreview.js';
import { formatTimecode } from '../../../utils/formatters.js';

const FILTER_LABELS = [['all', 'All'], ['attention', 'Needs attention'], ['missing', 'Missing footage']];
const isTypingTarget = (el) => !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/**
 * Board: plan and arrange the shots, the beat timeline, and the scene cards —
 * one column on a phone, two and three as the column widens (a container
 * query, so the docked preview narrowing the column is accounted for). Cards
 * are collapsed to a thumbnail, lyric and status until tapped.
 */
export default function BoardStage({ board }) {
  const { project, locked, busy, sceneMedia, videoSettings, takes, treatment, activeSceneId, onToggleSceneExpand } = board;
  const scenes = project.scenes || [];
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = parseSceneFilter(searchParams.get('scenes'));
  const setFilter = (next) => setSearchParams((prev) => {
    const params = new URLSearchParams(prev);
    if (next === 'all') params.delete('scenes'); else params.set('scenes', next);
    return params;
  }, { replace: true });
  const layered = isLayeredComposition(project);
  const lipSyncBackend = videoSettings.audioReactiveSelected ? 'local' : videoSettings.settings.backend;
  const songDurationSec = project.audioAnalysis?.durationSec ?? null;
  const attentionCtx = {
    layered, lipSyncBackend, songDurationSec, failed: sceneMedia.failedScenes,
    footageOptional: FOOTAGE_OPTIONAL_MODES.has(project.composition?.mode || 'concat'),
  };
  const codesById = new Map(scenes.map((scene) => [scene.sceneId, sceneAttention(scene, attentionCtx)]));
  const counts = { all: scenes.length, attention: 0, missing: 0 };
  for (const codes of codesById.values()) {
    if (sceneMatchesFilter(codes, 'attention')) counts.attention += 1;
    if (sceneMatchesFilter(codes, 'missing')) counts.missing += 1;
  }
  // The open scene stays listed while it is edited, even once fixing it drops it from the filter.
  const visible = scenes.filter((scene) => scene.sceneId === activeSceneId || sceneMatchesFilter(codesById.get(scene.sceneId), filter));
  const visibleIds = visible.map((scene) => scene.sceneId).join('\n');
  const thumbnailsRef = useRef(new Map());
  const inspectorRef = useRef(null);
  const focusAfterNavigation = useRef(null);
  const toggleInspector = (sceneId, open) => {
    if (!open) focusAfterNavigation.current = { target: 'thumbnail', sceneId };
    onToggleSceneExpand?.(sceneId, open);
  };
  useLayoutEffect(() => {
    const pending = focusAfterNavigation.current;
    if (!pending) return;
    const target = pending.target === 'thumbnail' ? thumbnailsRef.current.get(pending.sceneId) || thumbnailsRef.current.values().next().value
      : inspectorRef.current?.querySelector('summary');
    if (target) { target.focus({ preventScroll: true }); focusAfterNavigation.current = null; }
  }, [activeSceneId]);
  // j / k step through the listed scenes (opening one, which also routes to it).
  useEffect(() => {
    const ids = visibleIds ? visibleIds.split('\n') : [];
    const onKey = (e) => {
      if ((e.key !== 'j' && e.key !== 'k') || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || !ids.length) return;
      const at = ids.indexOf(activeSceneId);
      const next = e.key === 'j' ? Math.min(at + 1, ids.length - 1) : Math.max(at === -1 ? 0 : at - 1, 0);
      if (ids[next] !== activeSceneId) {
        e.preventDefault();
        if (inspectorRef.current?.contains(document.activeElement)) focusAfterNavigation.current = { target: 'inspector' };
        onToggleSceneExpand?.(ids[next], true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleIds, activeSceneId, onToggleSceneExpand]);
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
      <StageSection title="Planning tools">
        <PlanActions project={project} busy={busy} onPlan={board.onPlan} onAutoArrange={board.onAutoArrange} />
        <ShotPacingFields project={project} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} />
      </StageSection>

      <StageSection id="mv-board-treatment" title="Treatment" summary={scenes.length ? treatmentSummary(project) : 'Plan shots to direct them'}>
        <TreatmentPanel key={`treatment-${project.id}`} project={project} treatment={treatment} part="direction"
          storyboardApproved={!!board.productionReadiness?.storyboard?.approved} />
      </StageSection>

      {project.audioAnalysis && scenes.length > 0 && (
        <StageSection title="Beat timeline">
        <BeatTimeline audioAnalysis={project.audioAnalysis} scenes={scenes} lyricCues={project.lyricCues} narrativeEvents={project.composition?.narrativeEvents}
          onSeek={(startSec) => board.seekToScene({ startSec })} onCommit={board.commitSceneTiming} />
        </StageSection>
      )}

      <div id="mv-scene-board" className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Scene board</h3>
        <div className="flex items-center gap-2">
          <ContactSheetButton onOpen={board.openContactSheet} />
          <button onClick={board.onAddScene} className="flex min-h-[44px] items-center gap-1 rounded bg-port-accent px-2 py-1.5 text-sm text-white sm:min-h-0">
            <Plus size={15} /> Add scene
          </button>
        </div>
      </div>

      {scenes.length === 0 && <p className="text-sm text-port-text-muted">No scenes yet — add one to start the board.</p>}
      {scenes.length > 0 && (
        <div role="group" aria-label="Filter scenes" className="flex flex-wrap items-center gap-1.5 text-xs">
          {FILTER_LABELS.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}
              className={`min-h-[44px] rounded border px-2 py-1 sm:min-h-0 ${filter === id ? 'border-port-accent bg-port-accent/10 text-port-accent' : 'border-port-border text-port-text-muted'}`}>
              {label} ({counts[id]})
            </button>
          ))}
          <span className="hidden text-port-text-muted sm:inline">j / k to move between scenes</span>
        </div>
      )}
      {scenes.length > 0 && visible.length === 0 && (
        <p className="text-sm text-port-text-muted">No scenes match this filter.</p>
      )}
      <div className="@container">
        <div className="grid grid-cols-2 items-start gap-2 @2xl:grid-cols-3 @5xl:grid-cols-4" aria-label="Storyboard thumbnails">
          {visible.map(scene => <button key={scene.sceneId} type="button" aria-pressed={activeSceneId === scene.sceneId}
            ref={element => { if (element) thumbnailsRef.current.set(scene.sceneId, element); else thumbnailsRef.current.delete(scene.sceneId); }}
            onClick={() => { board.seekToScene?.(scene); onToggleSceneExpand?.(scene.sceneId, true); }}
            aria-label={`Open ${scene.sectionLabel || scene.label || `Scene ${scene.order + 1}`}`}
            className={`min-w-0 rounded border p-2 text-left ${activeSceneId === scene.sceneId ? 'border-port-accent bg-port-accent/10' : 'border-port-border bg-port-card'}`}>
            {scene.referenceImageId ? <img src={musicVideoImageSrc(scene.referenceImageId)} alt="" loading="lazy" className="aspect-video w-full rounded object-cover" />
              : <span className="flex aspect-video items-center justify-center rounded bg-port-bg text-port-text-muted"><ImageIcon size={22} aria-hidden="true" /></span>}
            <span className="mt-1 block truncate text-sm">{scene.sectionLabel || scene.label || `Scene ${scene.order + 1}`}</span>
            <span className="block text-xs text-port-text-muted">{formatTimecode(scene.startSec)}–{formatTimecode(scene.endSec)}</span>
            {codesById.get(scene.sceneId).length > 0 && <span className="block text-xs text-port-warning">{SCENE_ATTENTION_LABELS[codesById.get(scene.sceneId)[0]]}</span>}
          </button>)}
        </div>
        <div ref={inspectorRef} className="mt-3">
          {scenes.map((scene, idx) => scene.sceneId !== activeSceneId ? null : (
            <SceneCard
              key={scene.sceneId}
              scene={scene}
              expanded={activeSceneId === scene.sceneId}
              onToggleExpand={toggleInspector}
              performanceReview={performanceReviews.get(`${scene.sceneId}:${scene.videoHistoryId}`)}
              index={idx}
              isLast={idx === scenes.length - 1}
              generatingFrame={sceneMedia.genScenes[scene.sceneId]}
              generatingVideo={sceneMedia.genVideoScenes[scene.sceneId]}
              frameProgress={sceneMedia.sceneProgress?.[scene.sceneId]}
              videoProgress={sceneMedia.videoSceneProgress?.[scene.sceneId]}
              settingsSaving={videoSettings.saving}
              videoBlockedReason={videoSettings.videoBlockedReason}
              lipSyncBackend={lipSyncBackend}
              songDurationSec={songDurationSec}
              footageOptional={attentionCtx.footageOptional}
              failedScenes={sceneMedia.failedScenes}
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
              layered={layered}
            />
          ))}
        </div>
      </div>
    </fieldset>
  );
}
