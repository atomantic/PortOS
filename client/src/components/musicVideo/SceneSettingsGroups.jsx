import { useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { normalizeShotSheet, shotSheetPromptLines } from '../../../../server/lib/musicVideo/musicVideoShotSheet.js';
import { MUSIC_VIDEO_MEDIUM_LABELS } from '../../../../server/lib/musicVideo/musicVideoMediumPlan.js';
import { clipSoundSummary } from '../../../../server/lib/musicVideo/musicVideoClipSound.js';
import { isPreMusicShot, normalizePreMusic, preMusicSoundSummary } from '../../../../server/lib/musicVideo/musicVideoColdOpen.js';
import { MUSIC_VIDEO_VISUAL_LAYERS, clipReversed, composedDrawsLyrics, sceneHasAuthoredSpan } from '../../lib/musicVideoLayers.js';
import { plannedTransitions } from '../../lib/musicVideoCutEffects.js';
import { shotEffectLabel, shotEffects } from '../../lib/musicVideoShotEffects.js';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import PlateComparison from './PlateComparison.jsx';
import SceneCameraControls from './SceneCameraControls.jsx';
import SceneClipSound from './SceneClipSound.jsx';
import SceneCutEffect from './SceneCutEffect.jsx';
import SceneGlitches from './SceneGlitches.jsx';
import SceneImageTreatments from './SceneImageTreatments.jsx';
import SceneLyricType from './SceneLyricType.jsx';
import { PreMusicSound, PreMusicTiming } from './ScenePreMusic.jsx';
import SceneShotCuts, { SceneCutField, SceneDuration } from './SceneShotCuts.jsx';
import SceneStartFrame from './SceneStartFrame.jsx';
import SceneTimingPlan from './SceneTimingPlan.jsx';
import SceneTransitions from './SceneTransitions.jsx';
import ShotActionInspector from './ShotActionInspector.jsx';
import ShotColorMatch from './ShotColorMatch.jsx';
import ShotEditorGroup from './ShotEditorGroup.jsx';
import ShotFilmLook from './ShotFilmLook.jsx';
import ShotFinalRender from './ShotFinalRender.jsx';
import ShotSheetFields from './ShotSheetFields.jsx';
import { SceneSpeakerField } from './ScenePromptField.jsx';
import { LAYER_LABELS, SCENE_TIME_FIELDS, SECONDARY_BUTTON, SHOT_MODE_LABELS, STILL_MOVE_LABELS, frameAt, frameSpan } from './sceneCardProps.js';

// Where the shot sits in the cut: move it a slot earlier or later (the song timing and
// lyric stay with the slot), or delete it after a confirm.
function SceneOrderActions({ index, isLast, manifestOwnsShots, shotOrderOwner, onMove, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {onMove && (
          <>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => onMove(index, -1)} disabled={index === 0 || manifestOwnsShots}>
              <ArrowUp size={12} aria-hidden="true" /> Move earlier
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => onMove(index, 1)} disabled={isLast || manifestOwnsShots}>
              <ArrowDown size={12} aria-hidden="true" /> Move later
            </button>
          </>
        )}
        {onDelete && (confirming ? (
          <ConfirmButtonPair prompt="Delete this shot?" confirmText="Delete shot" confirmIcon={Trash2} className="ml-auto"
            onConfirm={() => { setConfirming(false); onDelete(); }} onCancel={() => setConfirming(false)} responsiveTouchTargets />
        ) : (
          <button type="button" onClick={() => setConfirming(true)}
            className="ml-auto flex min-h-[44px] items-center gap-1 rounded px-2 py-1.5 text-xs text-port-error hover:bg-port-error/15 pointer-fine:sm:min-h-0">
            <Trash2 size={12} aria-hidden="true" /> Delete shot
          </button>
        ))}
      </div>
      {manifestOwnsShots && (
        <p className="text-[11px] text-port-text-muted">Shot order comes from {shotOrderOwner}, so it can&apos;t be reordered here.</p>
      )}
    </div>
  );
}

/**
 * Timing editor group: pre-music toggle, frame-stepped start/duration, start/end fields,
 * beat-aligned/loop checkboxes, split/merge controls, and shot order/delete actions.
 */
export function SceneTimelineActions({
  scene, layer, preMusic, loops, performance, timing, renderLane,
  position, composition, actions, fieldId, applyPatch, markDirty, saveIfDirty, moveStart, moveEnd,
}) {
  const { index, isLast, nextEndSec } = position;
  const { songDurationSec, manifestOwnsShots, shotOrderOwner } = composition;
  const { onEditLocal, onSave, onSplit, onMergeNext, onMergePrevious, onMove, onDelete } = actions;
  const hasSpan = sceneHasAuthoredSpan(scene);
  const cutMoves = hasSpan ? { startSec: moveStart, endSec: moveEnd } : {};
  const timingSummary = [
    preMusic ? `before the song · ${normalizePreMusic(scene.preMusic).durationSec.toFixed(2)}s` : null,
    !preMusic && typeof scene.startSec === 'number' && typeof scene.endSec === 'number' ? `${scene.startSec.toFixed(2)}–${scene.endSec.toFixed(2)}s (${frameSpan(scene)})` : null,
    scene.beatAligned ? 'beat-aligned' : null,
    scene.pacingCut ? 'pacing cut' : null,
    layer === 'footage' && loops && !performance ? 'loops' : null,
  ].filter(Boolean).join(' · ');

  return (
    <ShotEditorGroup title="Timing" summary={timingSummary} testId="shot-group-timing">
      {/* Whether the shot plays before the song (the cold open), with its own length. */}
      <PreMusicTiming fieldId={fieldId} scene={scene} onChange={applyPatch} />
      {/* Move the cut before this shot a frame at a time; the shot before ends where this one starts. */}
      {!preMusic && moveStart && hasSpan && (
        <SceneStartFrame id={fieldId('start-frame')} scene={scene} joinsPrevious={(scene.order ?? index) > 0} onMove={moveStart} />
      )}
      {/* How long the shot runs; the next shot grows or shrinks to meet the new end. */}
      {!preMusic && moveEnd && hasSpan && (
        <SceneDuration id={fieldId('duration')} scene={scene} nextEndSec={isLast ? null : nextEndSec} songDurationSec={songDurationSec} onMoveEnd={moveEnd} />
      )}
      <div className="flex flex-wrap gap-2 items-center text-xs">
        {!preMusic && SCENE_TIME_FIELDS.map(([labelText, key]) => {
          const toValue = (v) => (v === '' ? null : Number(v));
          if (cutMoves[key]) return <SceneCutField key={key} label={labelText} value={scene[key]} onCommit={(sec) => cutMoves[key](scene.sceneId, sec)} />;
          return (
            <label key={key} className="flex items-center gap-1">{labelText}
              <input type="number" min="0" step="0.1" value={scene[key] ?? ''} className="w-20 bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0"
                onChange={(e) => { markDirty(key); onEditLocal(scene.sceneId, { [key]: toValue(e.target.value) }); }}
                onBlur={(e) => saveIfDirty(key, { [key]: toValue(e.target.value) })} />
              {typeof scene[key] === 'number' && <span className="tabular-nums text-port-text-muted">fr {frameAt(scene[key])}</span>}
            </label>
          );
        })}
        <label className="flex items-center gap-1 min-h-[44px] pointer-fine:sm:min-h-0">
          <input type="checkbox" checked={!!scene.beatAligned}
            onChange={(e) => { onEditLocal(scene.sceneId, { beatAligned: e.target.checked }); onSave(scene.sceneId, { beatAligned: e.target.checked }); }} />
          Beat-aligned
        </label>
        <label className="flex items-center gap-1 min-h-[44px] pointer-fine:sm:min-h-0" title="Repeat the generated clip to fill a span longer than the clip. Off: the shot must be covered by its clip (trim, continue, or replace it).">
          <input type="checkbox" checked={loops} disabled={performance || clipReversed(scene)} onChange={(e) => applyPatch({ loop: e.target.checked })} />
          Loop clip
        </label>
      </div>
      {/* Split and merge belong to the shot, not its render, so a photo or a shot with no clip has them too. */}
      {!preMusic && (
        <SceneShotCuts timing={timing} sceneId={scene.sceneId} lipSyncBackend={renderLane} onSplit={onSplit} onMergeNext={onMergeNext} onMergePrevious={onMergePrevious}
          span={hasSpan ? { startSec: scene.startSec, endSec: scene.endSec } : null} />
      )}
      <SceneOrderActions index={index} isLast={isLast} manifestOwnsShots={manifestOwnsShots} shotOrderOwner={shotOrderOwner}
        onMove={onMove} onDelete={onDelete ? () => onDelete(scene.sceneId) : null} />
    </ShotEditorGroup>
  );
}

function SceneShotTypeGroup({ scene, layer, performance, layered, documentComposition, fieldId, applyPatch, markDirty, saveIfDirty, onEditLocal, onSave }) {
  const shotModeValue = performance ? (scene.performanceStyle === 'music' ? 'music' : 'performance') : 'cutaway';
  const shotModeId = `mv-shot-mode-${scene.sceneId}`;
  const typeSummary = [
    layer === 'footage' ? SHOT_MODE_LABELS[shotModeValue] : LAYER_LABELS[layer],
    layer !== 'footage' && scene.camera?.move ? `camera ${scene.camera.move}` : null,
  ].filter(Boolean).join(' · ');

  const onShotModeChange = (value) => {
    if (value === 'cutaway') { applyPatch({ shotMode: 'cutaway' }); return; }
    if (value === 'music') { applyPatch({ shotMode: 'performance', performanceStyle: 'music' }); return; }
    // Clear the style only when one is stored, so a plain lip-sync switch stays one field.
    applyPatch({ shotMode: 'performance', ...(scene.performanceStyle ? { performanceStyle: null } : {}) });
  };

  return (
    <ShotEditorGroup title="Shot type" summary={typeSummary} testId="shot-group-type">
      <div className="flex flex-wrap gap-2 items-center text-xs">
        <label htmlFor={fieldId('layer')}>Layer</label>
        <select id={fieldId('layer')} value={layer} onChange={(e) => applyPatch({ visualLayer: e.target.value })}
          className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0">
          {MUSIC_VIDEO_VISUAL_LAYERS.map((value) => <option key={value} value={value}>{LAYER_LABELS[value]}</option>)}
        </select>
        {/* A performance is sung footage — only the footage layer offers it. */}
        {layer === 'footage' && (
          <>
            <label htmlFor={shotModeId} className="flex items-center gap-1">Shot</label>
            <select id={shotModeId} value={shotModeValue} onChange={(e) => onShotModeChange(e.target.value)}
              className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0"
              title="Cutaway: any video lane animates the frame under the song. Lip-sync: a singer's mouth follows the song. Music-driven: the song slice drives the whole frame's motion (a drummer on the beat). Both need a source-audio provider.">
              {Object.entries(SHOT_MODE_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
            {/* #14241: neighbouring cutaways on one set can share one timed generation. */}
            {shotModeValue === 'cutaway' && (
              <>
                <label htmlFor={fieldId('coverage')}>Coverage</label>
                <select id={fieldId('coverage')} value={scene.coverage === 'sequence' ? 'sequence' : 'per-shot'}
                  onChange={(e) => applyPatch({ coverage: e.target.value })}
                  className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0"
                  title="Per shot: one clip per shot. Sequence: neighbouring cutaways that share a set and protagonist render in one timed request, cut back onto each shot.">
                  <option value="per-shot">Per shot</option>
                  <option value="sequence">Sequence</option>
                </select>
              </>
            )}
          </>
        )}
        {layer === 'still' && (
          <>
            <label htmlFor={fieldId('move')}>Move</label>
            <select id={fieldId('move')} value={scene.stillMove || 'hold'} onChange={(e) => applyPatch({ stillMove: e.target.value })}
              disabled={documentComposition && !!scene.camera?.move} title={documentComposition && scene.camera?.move ? 'The planned camera move drives this still.' : undefined}
              className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50">
              {STILL_MOVE_LABELS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </>
        )}
        {layer === 'card' && (
          <>
            <label htmlFor={fieldId('card-text')}>Card text</label>
            <input id={fieldId('card-text')} type="text" maxLength={500} value={scene.cardText || ''}
              placeholder="Title shown on the card"
              onChange={(e) => { markDirty('cardText'); onEditLocal(scene.sceneId, { cardText: e.target.value }); }}
              onBlur={(e) => saveIfDirty('cardText', { cardText: e.target.value.trim() || null })}
              className="min-w-0 flex-1 basis-40 bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0" />
            <label htmlFor={fieldId('card-color')}>Background</label>
            <input id={fieldId('card-color')} type="color" value={scene.cardColor || '#000000'}
              onChange={(e) => { markDirty('cardColor'); onEditLocal(scene.sceneId, { cardColor: e.target.value }); }}
              onBlur={(e) => saveIfDirty('cardColor', { cardColor: e.target.value })}
              className="h-8 w-10 min-h-[44px] pointer-fine:sm:min-h-0 bg-port-bg border border-port-border rounded" />
          </>
        )}
      </div>
      {layer !== 'footage' && !layered && (
        <p className="text-[11px] text-port-text-muted">
          {LAYER_LABELS[layer]} sections render in composed or document mode — a plain render plays this scene&apos;s footage.
        </p>
      )}
      {layer !== 'card' && layer !== 'footage' && <SceneCameraControls scene={scene} fieldId={fieldId} onEditLocal={onEditLocal} onSave={onSave} />}
    </ShotEditorGroup>
  );
}

function SceneDirectionGroup({ project, scene }) {
  if (!scene.visualIntent && !scene.direction && !scene.direction?.actionContract) return null;
  return (
    <ShotEditorGroup title="Direction" summary={scene.visualIntent} defaultOpen={false} testId="shot-group-direction">
      <div className="space-y-2 text-[11px] text-port-text-muted">
        {scene.visualIntent && <p className="break-words">Intent: {scene.visualIntent}</p>}
        {/* Applied treatment direction (#8980) — appended to both generated prompts. */}
        {scene.direction && (
          <p className="break-words" title={scene.direction.frameClause}>
            Direction: {scene.direction.mode}
            {scene.direction.medium ? ` · planned ${MUSIC_VIDEO_MEDIUM_LABELS[scene.direction.medium] || scene.direction.medium}${scene.direction.mediumPinned ? ' (pinned)' : ''}` : ''}
            {scene.direction.focalSubject ? ` · ${scene.direction.focalSubject}` : ''}
            {scene.direction.typographyRole !== 'none' ? ` · ${scene.direction.typographyRole} text, ${scene.direction.negativeSpace} region kept clear` : ' · no text'}
          </p>
        )}
        <ShotActionInspector contract={scene.direction?.actionContract} scene={scene} />
        <PlateComparison project={project} scene={scene} frames={false} />
      </div>
    </ShotEditorGroup>
  );
}

/**
 * Right-column settings groups in the shot editor: Shot details, Timing, Sound,
 * Transitions & effects, Lyrics, Shot type, Composition finish, and Direction.
 */
export default function SceneSettingsGroups({
  scene, project, layer, codeShot, fromSheet, loops, sourceWindow,
  renderPlan, position, composition, actions, fieldId,
  applyPatch, applySaved, markDirty, saveIfDirty, moveStart, moveEnd, saveShot,
  setSpeakerDirty, setSpeakerSaving,
}) {
  const preMusic = isPreMusicShot(scene);
  const { layered, documentComposition } = composition;
  const planned = plannedTransitions(project?.productionReview?.draft?.storyboard);
  const sheetCamera = (project?.cameras || []).find((entry) => entry?.id && entry.id === scene.shotSheet?.cameraId) || null;
  const effectLabels = [...new Set(Object.values(shotEffects(scene, { layered, planned, cameras: project?.cameras })).flat().map(shotEffectLabel))];
  const effectsSummary = effectLabels.join(', ') || 'none';
  const lyricType = !preMusic && (documentComposition || (layer !== 'card' && composedDrawsLyrics(project)));
  const detailsSummary = fromSheet
    ? shotSheetPromptLines(project, scene).map((line) => line.label.toLowerCase()).join(', ') || 'none set'
    : 'not in the prompts';

  return (
    <div className="min-w-0 space-y-2">
      {codeShot && !preMusic && <SceneTimingPlan timing={renderPlan.timing} lipSyncBackend={renderPlan.renderLane} />}
      {codeShot && (
        <SceneSpeakerField scene={scene} performance={renderPlan.performance} fieldId={fieldId}
          onEditLocal={actions.onEditLocal} onSave={actions.onSave}
          setSpeakerDirty={setSpeakerDirty} setSpeakerSaving={setSpeakerSaving} />
      )}
      {!codeShot && layer !== 'card' && (
        <ShotEditorGroup title="Shot details" summary={detailsSummary} defaultOpen testId="shot-group-details">
          <label htmlFor={fieldId('from-sheet')} className="flex items-center gap-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0">
            <input id={fieldId('from-sheet')} type="checkbox" checked={fromSheet}
              onChange={(e) => applyPatch({ shotSheet: normalizeShotSheet({ ...scene.shotSheet, promptFromSheet: e.target.checked }) })} />
            Use these details in the prompts
          </label>
          <p className="text-[11px] text-port-text-muted">
            {fromSheet
              ? 'Each detail is added to the still prompt and the clip prompt as its own labeled part (shown under each prompt). The prompt boxes hold only what the details don\'t cover.'
              : 'Off: this shot\'s hand-written prompts are sent as they are. To move a long prompt into these details, use Split frame prompts into details on the shot sheet.'}
          </p>
          <ShotSheetFields project={project} scene={scene} onChange={applyPatch} />
        </ShotEditorGroup>
      )}
      <SceneTimelineActions
        scene={scene} layer={layer} preMusic={preMusic} loops={loops}
        performance={renderPlan.performance} timing={renderPlan.timing} renderLane={renderPlan.renderLane}
        position={position} composition={composition} actions={actions} fieldId={fieldId}
        applyPatch={applyPatch} markDirty={markDirty} saveIfDirty={saveIfDirty}
        moveStart={moveStart} moveEnd={moveEnd}
      />
      {preMusic && (
        <ShotEditorGroup title="Sound" summary={preMusicSoundSummary(scene.preMusic).toLowerCase()} testId="shot-group-sound">
          <PreMusicSound fieldId={fieldId} scene={scene} onChange={applyPatch} />
        </ShotEditorGroup>
      )}
      {!preMusic && layer === 'footage' && (
        <ShotEditorGroup title="Sound" summary={(clipSoundSummary(scene) || 'silent under the song').toLowerCase()} testId="shot-group-sound">
          <SceneClipSound fieldId={fieldId} scene={scene} onChange={applyPatch} documentComposition={documentComposition}
            hasSelectedTake={Boolean(sourceWindow?.videoHistoryId || scene.videoHistoryId)} />
        </ShotEditorGroup>
      )}
      <ShotEditorGroup title="Transitions & effects" summary={effectsSummary} testId="shot-group-effects">
        {/* A glitch or a wipe on the cut into or out of this shot; never moves the cut. */}
        <SceneTransitions fieldId={fieldId} scene={scene} defaults={sheetCamera?.cuts || null} onChange={applyPatch} isLast={!!position.isLast}
          onVaryWipes={actions.onVaryWipes ? (count) => actions.onVaryWipes(scene.sceneId, count) : null} />
        {/* How this shot hands over to the next: a cut, beat toggle, dissolve or fade, as its storyboard row plans until one is picked. */}
        <SceneCutEffect fieldId={fieldId} scene={scene} isLast={!!position.isLast} onChange={applyPatch} planned={planned.get(scene.sceneId)} />
        {/* Glitches at moments inside the shot, set and moved on a slider; they add no time. */}
        <SceneGlitches fieldId={fieldId} scene={scene} onChange={applyPatch} />
      </ShotEditorGroup>
      <SceneImageTreatments key={scene.sceneId} project={project} scene={scene} onSave={saveShot} />
      {/* Where the lyrics over this shot sit, their style and size, whenever the render draws lyrics (a card draws its own text). */}
      {lyricType && (
        <ShotEditorGroup title="Lyrics" testId="shot-group-lyrics">
          <SceneLyricType fieldId={fieldId} scene={scene} onChange={applyPatch} />
        </ShotEditorGroup>
      )}
      {/* What the shot is: its layer, a footage shot's mode, a still's move, a card's text, a non-footage shot's camera. */}
      <SceneShotTypeGroup
        scene={scene} layer={layer} performance={renderPlan.performance}
        layered={layered} documentComposition={documentComposition} fieldId={fieldId}
        applyPatch={applyPatch} markDirty={markDirty} saveIfDirty={saveIfDirty}
        onEditLocal={actions.onEditLocal} onSave={actions.onSave}
      />
      {/* This shot's piece of the composed final render: cached or not, Render shot, its film look. */}
      {project?.composition?.mode === 'document' && (
        <>
          <ShotColorMatch project={project} scene={scene} fieldId={fieldId} onApplied={applySaved} />
          <ShotFilmLook project={project} scene={scene} onChange={applyPatch} fieldId={fieldId} />
        </>
      )}
      {project?.composition?.mode === 'composed' && (
        <ShotFinalRender project={project} scene={scene} onChange={applyPatch} onLocal={applySaved} fieldId={fieldId} />
      )}
      <SceneDirectionGroup project={project} scene={scene} />
    </div>
  );
}
