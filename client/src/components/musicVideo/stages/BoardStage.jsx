import { useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Plus, Image as ImageIcon, Film, Code2, Type, FlagTriangleRight, CheckCircle2, Undo2, X } from 'lucide-react';
import Drawer from '../../Drawer';
import ContactSheetButton from '../ContactSheetButton.jsx';
import PacingRecutPanel from '../PacingRecutPanel.jsx';
import ShotCardHost, { blenderShotPosters, shotNamer, useLinkedStoryboard } from '../ShotCardHost.jsx';
import CatalogShotReferenceProblems from '../CatalogShotReferenceProblems.jsx';
import useCatalogCastSetsCheckin from '../../../hooks/useCatalogCastSetsCheckin.js';
import useShotSheetMapFilter from '../../../hooks/useShotSheetMapFilter.js';
import { SHOT_SHEET_MAP_BARS, shotSheetMapRows, shotSheetRows } from '../../../../../server/lib/musicVideo/musicVideoShotSheet.js';
import EndingCard, { EndingThumbnail } from '../EndingCard.jsx';
import CreditsEndingCard, { CreditsThumbnail } from '../CreditsEndingCard.jsx';
import ScenePoster from '../ScenePoster.jsx';
import SharedTakeOffers from '../SharedTakeOffers.jsx';
import SequenceTakePanel from '../SequenceTakePanel.jsx';
import FinalUpgradePanel from '../FinalUpgradePanel.jsx';
import { sceneClipIsFinal, sceneFinalApproved } from '../../../../../server/lib/musicVideo/musicVideoFinalApproval.js';
import { sceneActiveEndImageId } from '../../../../../server/lib/musicVideo/musicVideoEndFrame.js';
import ShotEffectsCard, { SceneEffectBadges } from '../ShotEffectsCard.jsx';
import { isLayeredComposition } from '../../../lib/musicVideoLayers.js';
import { plannedTransitions } from '../../../../../server/lib/musicVideo/musicVideoCutEffects.js';
import { SHOT_EFFECT_OPTIONS, shotEffectCounts, shotEffectLabel, shotEffects, shotUsesEffect } from '../../../lib/musicVideoShotEffects.js';
import { FOOTAGE_OPTIONAL_MODES } from '../../../lib/musicVideoStages.js';
import { parseSceneFilter, sceneAttention, sceneMatchesFilter, sceneMediaKind, SCENE_ATTENTION_LABELS, SCENE_MEDIA_LABELS } from '../../../lib/musicVideoSceneAttention.js';
import { formatTimecode } from '../../../utils/formatters.js';
import { storyboardShotPanel } from '../../../../../server/lib/storyboardFit.js';

const FILTER_LABELS = [['all', 'All'], ['attention', 'Needs attention'], ['missing', 'Missing footage'], ['stale-frame', 'Frame out of date'], ['older-character', 'Older character reference'], ['bad-take', 'Selected take marked bad']];
const MEDIA_ICONS = { clip: Film, image: ImageIcon, code: Code2, card: Type };
const isTypingTarget = (el) => !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/** Corner chips on a Board thumbnail: what the shot's selected media is, plus an end-frame mark. */
function SceneMediaBadges({ scene, layered, scenes }) {
  const kind = sceneMediaKind(scene, { layered, scenes });
  const endFrame = sceneActiveEndImageId(scene);
  // #16136: where the shot's clip stands on the draft-to-final path.
  const tier = sceneClipIsFinal(scene) ? 'Final' : sceneFinalApproved(scene) ? 'Approved for final' : null;
  if (!kind && !endFrame && !tier) return null;
  const Icon = MEDIA_ICONS[kind];
  return (
    <span id={`scene-media-${scene.sceneId}`} className="absolute right-1 top-1 flex gap-1">
      {kind && <span className="port-media-overlay-strong inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none"><Icon size={11} aria-hidden="true" />{SCENE_MEDIA_LABELS[kind]}</span>}
      {endFrame && <span className="port-media-overlay-strong inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none"><FlagTriangleRight size={11} aria-hidden="true" />End frame</span>}
      {tier && <span className="port-media-overlay-strong inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none" data-testid="scene-tier-badge"><CheckCircle2 size={11} aria-hidden="true" />{tier}</span>}
    </span>
  );
}

const PANEL_NOTICES = { changed: 'Storyboard changed', missing: 'Storyboard panel deleted' };

/**
 * The scene board on Shots: a thumbnail per shot with its media marks
 * — two columns on a phone, three and four as the column widens (a container
 * query, so the docked preview narrowing the column is accounted for). A tapped
 * shot (or the ending after the song) opens its card in the side panel, where
 * its still and clip are made, so the board stays where it was.
 */
export default function BoardStage({ board }) {
  const { project, locked, sceneMedia, videoSettings, activeSceneId, onToggleSceneExpand } = board;
  const scenes = project.scenes || [];
  const blenderPosters = blenderShotPosters(project, board.blender);
  const catalog = useCatalogCastSetsCheckin(project, board.applyCatalogCheckin, board.applyShotReferenceRepair);
  const [storyboard, setStoryboard] = useLinkedStoryboard(project.storyboardId);
  // Until the board is read, a fitted shot shows no panel state rather than a false "deleted".
  const panelOf = (scene) => (storyboard ? storyboardShotPanel(storyboard, scene) : null);
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = parseSceneFilter(searchParams.get('scenes'));
  const setFilter = (next) => setSearchParams((prev) => {
    const params = new URLSearchParams(prev);
    if (next === 'all') params.delete('scenes'); else params.set('scenes', next);
    return params;
  }, { replace: true });
  // The ending after the song sits after the last shot; opening it is a search param on the board (a shot's route closes it).
  const navigate = useNavigate();
  // `ending=1` is the cutting room floor, `ending=credits` the credits.
  const endingParam = activeSceneId ? null : searchParams.get('ending');
  const endingOpen = endingParam === '1';
  const creditsOpen = endingParam === 'credits';
  const openEnding = (which = '1') => {
    const params = new URLSearchParams(searchParams);
    params.set('ending', which);
    navigate({ pathname: `/music-video/${project.id}/produce`, search: `?${params}` }, { replace: true });
  };
  const closeEnding = () => setSearchParams((prev) => {
    const params = new URLSearchParams(prev);
    params.delete('ending');
    return params;
  }, { replace: true });
  const layered = isLayeredComposition(project);
  const lipSyncBackend = videoSettings.audioReactiveSelected ? 'local' : videoSettings.settings.backend;
  const songDurationSec = project.audioAnalysis?.durationSec ?? null;
  const attentionCtx = {
    project, layered, lipSyncBackend, songDurationSec, failed: sceneMedia.failedScenes,
    footageOptional: FOOTAGE_OPTIONAL_MODES.has(project.composition?.mode || 'concat'),
    songReview: project.songRevision?.sceneReview || null,
    videoSettings: videoSettings.settings,
    scenes,
    assetMarks: project.assetMarks || {},
  };
  const codesById = new Map(scenes.map((scene) => [scene.sceneId, sceneAttention(scene, attentionCtx)]));
  const { shotName } = shotNamer(project);
  const counts = { all: scenes.length, attention: 0, missing: 0, 'stale-frame': 0, 'older-character': 0, 'bad-take': 0 };
  for (const codes of codesById.values()) {
    if (sceneMatchesFilter(codes, 'attention')) counts.attention += 1;
    if (sceneMatchesFilter(codes, 'missing')) counts.missing += 1;
    if (sceneMatchesFilter(codes, 'stale-frame')) counts['stale-frame'] += 1;
    if (sceneMatchesFilter(codes, 'older-character')) counts['older-character'] += 1;
    if (sceneMatchesFilter(codes, 'bad-take')) counts['bad-take'] += 1;
  }
  // Each shot's start, mid-shot and end effects, and the option the board is narrowed to (`?effect=`).
  const planned = plannedTransitions(project.productionReview?.draft?.storyboard);
  const effectsById = new Map(scenes.map((scene) => [scene.sceneId, shotEffects(scene, { layered, planned, cameras: project.cameras })]));
  const effectFilter = SHOT_EFFECT_OPTIONS.some((option) => option.id === searchParams.get('effect')) ? searchParams.get('effect') : null;
  const setEffectFilter = (next) => setSearchParams((prev) => {
    const params = new URLSearchParams(prev);
    if (next) params.set('effect', next); else params.delete('effect');
    return params;
  }, { replace: true });
  const [mapFilter, setMapFilter] = useShotSheetMapFilter();
  const onMap = new Set(shotSheetMapRows(shotSheetRows(project), mapFilter).map((row) => row.scene.sceneId));
  // The open scene stays listed while it is edited, even once fixing it drops it from the filter.
  const visible = scenes.filter((scene) => scene.sceneId === activeSceneId || (sceneMatchesFilter(codesById.get(scene.sceneId), filter)
    && onMap.has(scene.sceneId)
    && (!effectFilter || shotUsesEffect(effectsById.get(scene.sceneId), effectFilter))));
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
      : inspectorRef.current?.querySelector('[data-shot-heading]');
    if (target) { target.focus({ preventScroll: true }); focusAfterNavigation.current = null; }
  }, [activeSceneId]);
  // The open card's Previous / Next shot buttons walk every shot in play order, filter or not.
  const openShot = (scene) => {
    focusAfterNavigation.current = { target: 'inspector' };
    board.seekToScene?.(scene);
    onToggleSceneExpand?.(scene.sceneId, true);
  };
  const activeScene = scenes.find((scene) => scene.sceneId === activeSceneId) || null;
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
  // Cmd/Ctrl+Z undoes the last structural/timing board edit when focus is not inside a text field.
  const boardUndo = board.boardUndo ?? project.boardUndo ?? null;
  useEffect(() => {
    if (locked || !boardUndo?.count || !board.onUndoBoardEdit) return undefined;
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z' || isTypingTarget(e.target)) return;
      e.preventDefault();
      if (!board.undoingBoard) void board.onUndoBoardEdit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, boardUndo?.count, board.undoingBoard, board.onUndoBoardEdit]);
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      <div id="mv-scene-board" className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Scene board</h3>
        <div className="flex flex-wrap items-center gap-2">
          {boardUndo?.count > 0 && board.onUndoBoardEdit && (
            <button type="button" onClick={() => board.onUndoBoardEdit()} disabled={board.undoingBoard}
              title={`Undo ${boardUndo.label} (⌘Z)`} aria-label={`Undo ${boardUndo.label}`}
              className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-port-text hover:bg-port-border/40 disabled:opacity-50 pointer-fine:sm:min-h-0">
              <Undo2 size={15} aria-hidden="true" /> Undo{boardUndo.count > 1 ? ` (${boardUndo.count})` : ''}
            </button>
          )}
          <PacingRecutPanel key={project.id} project={project} disabled={locked || videoSettings.saving} onApplied={board.replaceProject} />
          <ContactSheetButton onOpen={board.openContactSheet} />
          <button onClick={board.onAddScene} className="flex min-h-[44px] items-center gap-1 rounded bg-port-accent px-2 py-1.5 text-sm text-white pointer-fine:sm:min-h-0">
            <Plus size={15} /> Add scene
          </button>
        </div>
      </div>

      {catalog.error && <p role="alert" className="text-xs text-port-error">{catalog.error}{' '}
        <button type="button" className="min-h-11 rounded border border-port-border px-2" onClick={catalog.retry}>Retry catalog check-in</button>
      </p>}
      <CatalogShotReferenceProblems checkin={catalog.checkin} disabled={locked || board.castSets?.busy || catalog.repairing} repairError={catalog.repairError}
        onRepair={catalog.repair} onRemap={board.castSets?.remapCatalogReferences} onOpenShot={sceneId => onToggleSceneExpand?.(sceneId, true)} />
      {scenes.length === 0 && <p className="text-sm text-port-text-muted">No scenes yet — add one to start the board.</p>}
      {scenes.length > 0 && (
        <div role="group" aria-label="Filter scenes" className="flex flex-wrap items-center gap-1.5 text-xs">
          {FILTER_LABELS.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}
              className={`min-h-[44px] rounded border px-2 py-1 pointer-fine:sm:min-h-0 ${filter === id ? 'border-port-accent bg-port-accent/10 text-port-accent' : 'border-port-border text-port-text-muted'}`}>
              {label} ({counts[id]})
            </button>
          ))}
          {effectFilter && (
            <button type="button" onClick={() => setEffectFilter(null)} aria-label={`Stop showing only shots with ${shotEffectLabel(effectFilter)}`}
              className="flex min-h-[44px] items-center gap-1 rounded border border-port-accent bg-port-accent/10 px-2 py-1 text-port-accent pointer-fine:sm:min-h-0">
              {shotEffectLabel(effectFilter)} <X size={12} aria-hidden="true" />
            </button>
          )}
          {mapFilter && (
            <button type="button" onClick={() => setMapFilter(null)} aria-label="Clear the map filter"
              className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-accent bg-port-accent/10 px-2 py-1 text-port-accent pointer-fine:sm:min-h-0">
              {SHOT_SHEET_MAP_BARS.find(([id]) => id === mapFilter.bar)[1]}: {mapFilter.value || 'Not set'} <X size={12} aria-hidden="true" />
            </button>
          )}
          <span className="hidden text-port-text-muted sm:inline">j / k to move between scenes</span>
        </div>
      )}
      {scenes.length > 0 && <SharedTakeOffers scenes={scenes} onSave={board.saveScene} />}
      {scenes.length > 1 && <SequenceTakePanel key={`sequence-take-${project.id}`} project={project} shotName={shotName} disabled={locked} />}
      {scenes.length > 0 && board.approveFinal && (
        <FinalUpgradePanel key={`final-upgrade-${project.id}`} project={project} shotName={shotName} disabled={locked || videoSettings.saving} onApprove={board.approveFinal}
          onUpscaleQueued={sceneMedia.trackShotUpscale}
          onOpenShot={(sceneId) => onToggleSceneExpand?.(sceneId, true)} />
      )}
      {scenes.length > 0 && (
        <ShotEffectsCard counts={shotEffectCounts([...effectsById.values()])} selected={effectFilter} onSelect={setEffectFilter} />
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
            aria-describedby={[(sceneMediaKind(scene, { layered, scenes }) || sceneActiveEndImageId(scene) || sceneClipIsFinal(scene) || sceneFinalApproved(scene)) && `scene-media-${scene.sceneId}`,
              scene.shotSheet?.checked && `scene-done-${scene.sceneId}`,
              Object.values(effectsById.get(scene.sceneId)).some((list) => list.length) && `scene-effects-${scene.sceneId}`].filter(Boolean).join(' ') || undefined}
            className={`min-w-0 rounded border p-2 text-left ${scene.shotSheet?.checked ? 'border-port-success bg-port-success/10' : 'border-port-border bg-port-card'} ${activeSceneId === scene.sceneId ? 'ring-2 ring-port-accent' : ''}`}>
            <span className="relative block">
              <ScenePoster src={blenderPosters.get(scene.sceneId)} scene={scene} scenes={scenes} className="aspect-video w-full rounded" />
              <SceneMediaBadges scene={scene} layered={layered} scenes={scenes} />
              <SceneEffectBadges sceneId={scene.sceneId} effects={effectsById.get(scene.sceneId)} />
            </span>
            <span className="mt-1 block truncate text-sm">{shotName(scene)}</span>
            {scene.shotSheet?.checked && <span id={`scene-done-${scene.sceneId}`} className="flex items-center gap-1 text-xs font-medium text-port-success"><CheckCircle2 size={12} aria-hidden="true" />Done</span>}
            {/* Run time first, then where it sits in the song. */}
            <span className="block text-xs text-port-text-muted">
              {Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && <span className="font-medium text-port-text">{(scene.endSec - scene.startSec).toFixed(2)}s · </span>}
              {formatTimecode(scene.startSec)}–{formatTimecode(scene.endSec)}
            </span>
            {codesById.get(scene.sceneId).length > 0 && <span className="block text-xs text-port-warning">{SCENE_ATTENTION_LABELS[codesById.get(scene.sceneId)[0]]}</span>}
            {PANEL_NOTICES[panelOf(scene)?.state] && <span className="block text-xs text-port-warning">{PANEL_NOTICES[panelOf(scene).state]}</span>}
          </button>)}
          {scenes.length > 0 && filter === 'all' && !mapFilter && (
            <EndingThumbnail project={project} open={endingOpen} onOpen={endingOpen ? closeEnding : () => openEnding('1')} />
          )}
          {scenes.length > 0 && filter === 'all' && !mapFilter && (
            <CreditsThumbnail project={project} open={creditsOpen} onOpen={creditsOpen ? closeEnding : () => openEnding('credits')} />
          )}
        </div>
      </div>
      {/* Portaled out of the fieldset above, so it carries its own lock. */}
      <Drawer open={!!activeScene || endingOpen || creditsOpen} size="xl"
        onClose={activeScene ? () => toggleInspector(activeScene.sceneId, false) : closeEnding}
        title={activeScene ? shotName(activeScene) : creditsOpen ? 'Credits' : 'Cutting room floor'}
        closeLabel={activeScene ? 'Close shot' : 'Close ending'}
        showHeader={!activeScene}>
        {/* A shot draws its own header (thumbnail, timing, previous / next, close) and locks only its body. */}
        <div ref={inspectorRef} className="min-w-0">
          {(endingOpen || creditsOpen) && (
            <fieldset disabled={locked} className="min-w-0">
              {endingOpen && (
                <EndingCard project={project} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} onClose={closeEnding} />
              )}
              {creditsOpen && (
                <CreditsEndingCard project={project} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} onClose={closeEnding} />
              )}
            </fieldset>
          )}
          {activeScene && (
            <ShotCardHost board={board} sceneId={activeScene.sceneId} storyboard={storyboard} onStoryboard={setStoryboard}
              onClose={() => toggleInspector(activeScene.sceneId, false)} onOpenShot={openShot} />
          )}
        </div>
      </Drawer>
    </fieldset>
  );
}
