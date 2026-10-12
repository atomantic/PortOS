import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { Plus, Image as ImageIcon, Film, Code2, Type, FlagTriangleRight, Lock, LockOpen } from 'lucide-react';
import ContactSheetButton from '../ContactSheetButton.jsx';
import SceneCard from '../SceneCard.jsx';
import ScenePoster from '../ScenePoster.jsx';
import { ShotLockContext, SHOT_LOCK_LABELS, overallShotLock } from '../ShotLock.jsx';
import { shotNumbers } from '../ShotStepper.jsx';
import { previousShot } from '../../../../../server/lib/musicVideoHandoffFrame.js';
import { isLayeredComposition } from '../../../lib/musicVideoLayers.js';
import { musicVideoAspect } from '../../../lib/musicVideoAspect.js';
import { FOOTAGE_OPTIONAL_MODES } from '../../../lib/musicVideoStages.js';
import { parseSceneFilter, sceneAttention, sceneMatchesFilter, sceneMediaKind, SCENE_ATTENTION_LABELS, SCENE_MEDIA_LABELS } from '../../../lib/musicVideoSceneAttention.js';
import { formatTimecode } from '../../../utils/formatters.js';

const FILTER_LABELS = [['all', 'All'], ['attention', 'Needs attention'], ['missing', 'Missing footage']];
const MEDIA_ICONS = { clip: Film, image: ImageIcon, code: Code2, card: Type };
const isTypingTarget = (el) => !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/** Corner chips on a Board thumbnail: what the shot's selected media is, plus an end-frame mark. */
function SceneMediaBadges({ scene, layered }) {
  const kind = sceneMediaKind(scene, { layered });
  if (!kind && !scene.endImageId) return null;
  const Icon = MEDIA_ICONS[kind];
  return (
    <span id={`scene-media-${scene.sceneId}`} className="absolute right-1 top-1 flex gap-1">
      {kind && <span className="port-media-overlay-strong inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none"><Icon size={11} aria-hidden="true" />{SCENE_MEDIA_LABELS[kind]}</span>}
      {scene.endImageId && <span className="port-media-overlay-strong inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none"><FlagTriangleRight size={11} aria-hidden="true" />End frame</span>}
    </span>
  );
}

const LOCK_BADGED = ['locked', 'still', 'changed'];

/**
 * Top-left mark on a Board thumbnail: locked, a video shot with only its still
 * locked ("Still"), or changed since it was locked (an open shot shows none).
 */
function SceneLockBadge({ sceneId, state }) {
  if (!LOCK_BADGED.includes(state)) return null;
  const Icon = state === 'changed' ? LockOpen : Lock;
  return (
    <span id={`scene-lock-${sceneId}`} title={SHOT_LOCK_LABELS[state]}
      className={`port-media-overlay-strong absolute left-1 top-1 inline-flex items-center gap-0.5 rounded p-0.5 text-[10px] font-medium leading-none ${state === 'changed' ? 'text-port-warning' : 'text-port-success'}`}>
      <Icon size={12} aria-hidden="true" />{state === 'still' && <span aria-hidden="true">Still</span>}<span className="sr-only">{SHOT_LOCK_LABELS[state]}</span>
    </span>
  );
}

/**
 * The scene board on Shots: a thumbnail per shot with its lock and media marks,
 * and the open shot's card, where its still and clip are made and locked —
 * one column on a phone, two and three as the column widens (a container
 * query, so the docked preview narrowing the column is accounted for). Cards
 * are collapsed to a thumbnail, lyric and status until tapped.
 */
export default function BoardStage({ board }) {
  const { project, locked, sceneMedia, videoSettings, takes, activeSceneId, onToggleSceneExpand } = board;
  const scenes = project.scenes || [];
  const lockValue = useContext(ShotLockContext);
  const shotLocks = Object.fromEntries(Object.entries(lockValue?.locks || {}).map(([id, still]) => [id, overallShotLock(still, lockValue.clips?.[id])]));
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
    songReview: project.songRevision?.sceneReview || null,
    videoSettings: videoSettings.settings,
  };
  // A locked shot is settled: its other takes are no longer something to review.
  const codesById = new Map(scenes.map((scene) => [scene.sceneId, sceneAttention(scene, { ...attentionCtx, locked: shotLocks[scene.sceneId] === 'locked' })]));
  const numbers = shotNumbers(scenes);
  const shotName = (scene) => [numbers.has(scene.sceneId) ? `Shot ${numbers.get(scene.sceneId)}` : null,
    scene.sectionLabel || scene.label].filter(Boolean).join(' · ') || `Scene ${scene.order + 1}`;
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
            aria-label={`Open ${shotName(scene)}`}
            aria-describedby={[LOCK_BADGED.includes(shotLocks[scene.sceneId]) && `scene-lock-${scene.sceneId}`,
              (sceneMediaKind(scene, { layered }) || scene.endImageId) && `scene-media-${scene.sceneId}`].filter(Boolean).join(' ') || undefined}
            className={`min-w-0 rounded border p-2 text-left ${activeSceneId === scene.sceneId ? 'border-port-accent bg-port-accent/10' : 'border-port-border bg-port-card'}`}>
            <span className="relative block">
              <ScenePoster scene={scene} className="aspect-video w-full rounded" />
              <SceneLockBadge sceneId={scene.sceneId} state={shotLocks[scene.sceneId]} />
              <SceneMediaBadges scene={scene} layered={layered} />
            </span>
            <span className="mt-1 block truncate text-sm">{shotName(scene)}</span>
            <span className="block text-xs text-port-text-muted">{formatTimecode(scene.startSec)}–{formatTimecode(scene.endSec)}</span>
            {codesById.get(scene.sceneId).length > 0 && <span className="block text-xs text-port-warning">{SCENE_ATTENTION_LABELS[codesById.get(scene.sceneId)[0]]}</span>}
          </button>)}
        </div>
        <div ref={inspectorRef} className="mt-3">
          {scenes.map((scene, idx) => scene.sceneId !== activeSceneId ? null : (
            <SceneCard
              key={scene.sceneId}
              scene={scene}
              project={project}
              expanded={activeSceneId === scene.sceneId}
              onToggleExpand={toggleInspector}
              performanceReview={performanceReviews.get(`${scene.sceneId}:${scene.videoHistoryId}`)}
              index={idx}
              shotNumber={numbers.get(scene.sceneId)}
              isLast={idx === scenes.length - 1}
              generatingFrame={sceneMedia.genScenes[scene.sceneId]}
              generatingVideo={sceneMedia.genVideoScenes[scene.sceneId]}
              frameProgress={sceneMedia.sceneProgress?.[scene.sceneId]}
              videoProgress={sceneMedia.videoSceneProgress?.[scene.sceneId]}
              settingsSaving={videoSettings.saving}
              videoBlockedReason={videoSettings.videoBlockedReason}
              videoBlockedReasonFor={videoSettings.blockedReasonFor}
              lipSyncBackend={lipSyncBackend}
              songDurationSec={songDurationSec}
              footageOptional={attentionCtx.footageOptional}
              failedScenes={sceneMedia.failedScenes}
              songReview={attentionCtx.songReview}
              falVideoSettings={videoSettings.settings}
              videoModels={videoSettings.models}
              defaultVideoModel={videoSettings.defaultModel}
              canContinueShot={board.canContinueShot}
              onMove={board.moveScene}
              onDelete={board.onDeleteScene}
              onSplit={board.onSplitScene}
              onMergeNext={board.onMergeNextScene}
              nextEndSec={scenes[idx + 1]?.endSec ?? null}
              onRepairPerformance={['code', 'document'].includes(project.composition?.mode) ? null : board.onRepairPerformance}
              repairBusy={board.repairBusy || videoSettings.saving}
              onEditLocal={board.editSceneLocal}
              onSave={board.saveScene}
              onGenerateFrame={sceneMedia.generateFrame}
              onGenerateEndFrame={sceneMedia.generateEndFrame}
              generatingEndFrame={sceneMedia.genEndFrameScenes?.[scene.sceneId]}
              onGenerateVideo={sceneMedia.generateSceneVideo}
              onContinueVideo={sceneMedia.continueSceneVideo}
              onOpenPreview={board.openPreview}
              onSeek={board.seekToScene}
              takeBusy={takes.busy}
              onSelectTake={takes.selectTake}
              onReviewTake={takes.reviewTake}
              onContinueFromPrevious={takes.continueFromPrevious}
              // The server's own neighbor rule: the shot before this one by start time.
              previousHasClip={Boolean(previousShot(project, scene.sceneId)?.videoHistoryId)}
              onImportTake={(target) => board.setPickerTarget({ type: 'take', sceneId: target.sceneId })}
              onImportClipTake={(target) => board.setPickerTarget({ type: 'clip', sceneId: target.sceneId })}
              onPlacePoolItem={takes.placePoolItem}
              onTrimClip={takes.trimClipTake}
              projectId={project.id}
              aspect={musicVideoAspect(project)}
              shotNumbers={numbers}
              layered={layered}
              documentComposition={project.composition?.mode === 'document'}
            />
          ))}
        </div>
      </div>
    </fieldset>
  );
}
