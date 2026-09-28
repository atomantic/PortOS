import { useRef, useState } from 'react';
import { Trash2, Activity, ArrowUp, ArrowDown, Image as ImageIcon, Video, Maximize2, AlertTriangle, ImagePlus, Clapperboard, Scissors } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';
import SceneTakeStrip from './SceneTakeStrip.jsx';
import { MUSIC_VIDEO_VISUAL_LAYERS, sceneHasAuthoredSpan } from '../../lib/musicVideoLayers.js';

// #8985: what a composed render shows for this scene's span.
const LAYER_LABELS = { footage: 'Footage', still: 'Still image', card: 'Title card' };
const STILL_MOVE_LABELS = [['hold', 'Hold'], ['push', 'Push in'], ['pan', 'Pan']];
import {
  grokCoverage, isPerformanceScene, performanceBlockedReason, performanceCapability, planPerformanceWindow, shotSplitLimit,
} from '../../lib/musicVideoShotTiming.js';

// The two timeline-bound scene fields rendered as identical number inputs.
const SCENE_TIME_FIELDS = [['Start', 'startSec'], ['End', 'endSec']];
// Mirrors render.js COVERAGE_TOLERANCE_SEC: a non-looping shot may run this far
// past its clip (the last frame holds); beyond it the render refuses (#8964).
const COVERAGE_TOLERANCE_SEC = 0.25;

/**
 * One scene on the board: ordering/delete, the shot + reference-frame prompts
 * (optimistic local edit, PATCH on blur), the authored timeline span, and the
 * per-scene reference-frame / clip render controls.
 *
 * `onOpenPreview(key)` opens the page-level MediaLightbox for a frame
 * (`image:<filename>`) or clip (`video:<historyId>`). The frame thumb is the
 * whole button; the clip keeps native play/pause and uses a corner expand
 * control so the open handler never fights the player.
 *
 * Each slot's takes (#8965) render as a review strip under it: a regenerate
 * adds a candidate rather than replacing the selection, and the director picks,
 * rejects, or notes takes there. `onImportTake` adds an externally generated
 * frame (gallery pick or upload) as a take; `onImportClipTake` (#8978) does the
 * same for an existing gallery clip.
 *
 * The layer picker (#8985) chooses what a composed render (`layered`) shows
 * for the scene's span: its footage, its selected frame with a camera move, or
 * a title card. A plain render always plays footage, and says so.
 * The shot mode (#8977) picks Cutaway (any image-to-video lane) or Performance
 * (a singer lip-synced to the master recording). `lipSyncBackend` is the lane a
 * render would use ('' = install default); a performance shot on a lane without
 * verified source-audio conditioning is blocked here with the reason, and a
 * capable one names the provider, model, song window and cost before the
 * director spends anything. `songDurationSec` bounds the planned window.
 * A shot longer than that lane renders in one take (the lip-sync audio window,
 * or Grok's longest clip) offers `onSplit(sceneId, backend)`, which cuts it
 * into contiguous scenes at lyric pauses / phrase boundaries server-side.
 */
export default function SceneCard({
  scene, index, isLast, generatingFrame, generatingVideo,
  settingsSaving, videoBlockedReason, canContinueShot,
  onMove, onDelete, onEditLocal, onSave,
  onGenerateFrame, onGenerateVideo, onContinueVideo,
  onOpenPreview, onSelectTake, onReviewTake, onImportTake, onImportClipTake, takeBusy = false, layered = false,
  lipSyncBackend = '', songDurationSec = null, onSplit,
}) {
  // Pause the inline clip before opening the lightbox so the user can't hear
  // two desynced copies — MediaLightbox autoplays unmuted, and the thumb's
  // native controls let the user unmute it first (muted is only initial).
  const clipPlayerRef = useRef(null);
  // Resolve the clip's real stored filename rather than assuming `<id>.mp4` —
  // an imported .mov/.webm keeps its own container (videoUpload.js), so the
  // reconstructed path 404s for it (#8978). Falls back to the historical
  // reconstruction while the lookup is in flight or if it fails, same as
  // useVideoFileSrc's other ScenePreview-style callers.
  const clipFile = useVideoFileSrc(scene.videoHistoryId, { enabled: !!scene.videoHistoryId });
  const clipSrc = scene.videoHistoryId
    ? (clipFile.src || `/data/videos/${scene.videoHistoryId}.mp4`)
    : null;
  // Source-clip length, read from the inline player's metadata and keyed to
  // the clip it was measured from so a regenerated clip is re-measured.
  const [clipMeta, setClipMeta] = useState(null);
  const clipSec = clipMeta?.id === scene.videoHistoryId ? clipMeta.sec : null;
  // Pre-#8964 scenes have no `loop` key and keep the legacy loop-to-fill render.
  const loops = scene.loop !== false;
  const spanSec = scene.beatAligned && typeof scene.startSec === 'number' && typeof scene.endSec === 'number'
    ? scene.endSec - scene.startSec
    : null;
  const shortBySec = !loops && spanSec != null && clipSec != null ? spanSec - clipSec : 0;
  const underCovered = shortBySec > COVERAGE_TOLERANCE_SEC;
  const applyPatch = (patch) => { onEditLocal(scene.sceneId, patch); onSave(scene.sceneId, patch); };
  const layer = MUSIC_VIDEO_VISUAL_LAYERS.includes(scene.visualLayer) ? scene.visualLayer : 'footage';
  const fieldId = (name) => `mv-scene-${scene.sceneId}-${name}`;
  const performance = isPerformanceScene(scene);
  const capability = performance ? performanceCapability(lipSyncBackend) : null;
  const timedSpan = typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec
    ? scene.endSec - scene.startSec
    : null;
  const plan = capability
    ? planPerformanceWindow({ startSec: scene.startSec, endSec: scene.endSec, songDurationSec: songDurationSec ?? Infinity, capability })
    : null;
  const performanceBlocked = performance
    ? (capability ? (plan.ok ? null : plan.message) : performanceBlockedReason(lipSyncBackend))
    : null;
  const grokPlan = !performance && lipSyncBackend === 'grok' && timedSpan != null ? grokCoverage(timedSpan) : null;
  const splitLimit = layer === 'footage' ? shotSplitLimit(scene, lipSyncBackend) : null;
  const canSplit = splitLimit != null && timedSpan != null && timedSpan > splitLimit + 1e-6;
  const shotModeId = `mv-shot-mode-${scene.sceneId}`;
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">
            {scene.sectionLabel || scene.label || `Scene ${scene.order + 1}`}
          </div>
          <div className="text-[11px] text-port-text-muted">
            #{scene.order + 1}
            {typeof scene.startSec === 'number' && typeof scene.endSec === 'number'
              ? ` · ${formatDurationSec(scene.endSec - scene.startSec)} · ${formatDurationSec(scene.startSec)}–${formatDurationSec(scene.endSec)}`
              : ''}
            {scene.referenceImageId ? ' · frame ready' : ''}
            {scene.videoHistoryId ? ' · video ready' : ''}
            {clipSec != null ? ` · clip ${clipSec.toFixed(1)}s` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => onMove(index, -1)} disabled={index === 0} aria-label="Move up" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 disabled:opacity-30" title="Move up"><ArrowUp size={14} /></button>
          <button onClick={() => onMove(index, 1)} disabled={isLast} aria-label="Move down" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 disabled:opacity-30" title="Move down"><ArrowDown size={14} /></button>
          <button onClick={() => onDelete(scene.sceneId)} aria-label="Delete scene" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-error" title="Delete scene"><Trash2 size={14} /></button>
        </div>
      </div>
      <textarea
        aria-label="Shot prompt"
        value={scene.prompt || ''} rows={2}
        onChange={(e) => onEditLocal(scene.sceneId, { prompt: e.target.value })}
        onBlur={(e) => onSave(scene.sceneId, { prompt: e.target.value })}
        placeholder="Shot prompt — what this scene's video should show"
        className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
      />
      {(scene.lyricText || scene.visualIntent || scene.direction) && (
        <div className="text-[11px] text-port-text-muted space-y-0.5">
          {scene.lyricText && <p className="italic break-words">♪ {scene.lyricText}</p>}
          {scene.visualIntent && <p className="break-words">Intent: {scene.visualIntent}</p>}
          {/* Applied treatment direction (#8980) — appended to both generated prompts. */}
          {scene.direction && (
            <p className="break-words" title={scene.direction.frameClause}>
              Direction: {scene.direction.mode}{scene.direction.focalSubject ? ` · ${scene.direction.focalSubject}` : ''}
              {scene.direction.typographyRole !== 'none' ? ` · ${scene.direction.typographyRole} text, ${scene.direction.negativeSpace} region kept clear` : ' · no text'}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2 items-center text-xs">
        {SCENE_TIME_FIELDS.map(([labelText, key]) => {
          const toValue = (v) => (v === '' ? null : Number(v));
          return (
            <label key={key} className="flex items-center gap-1">{labelText}
              <input type="number" min="0" step="0.1" value={scene[key] ?? ''} className="w-16 bg-port-bg border border-port-border rounded px-1 py-1"
                onChange={(e) => onEditLocal(scene.sceneId, { [key]: toValue(e.target.value) })}
                onBlur={(e) => onSave(scene.sceneId, { [key]: toValue(e.target.value) })} />
            </label>
          );
        })}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={!!scene.beatAligned}
            onChange={(e) => { onEditLocal(scene.sceneId, { beatAligned: e.target.checked }); onSave(scene.sceneId, { beatAligned: e.target.checked }); }} />
          Beat-aligned
        </label>
        <label className="flex items-center gap-1" title="Repeat the generated clip to fill a span longer than the clip. Off: the shot must be covered by its clip (trim, continue, or replace it).">
          <input type="checkbox" checked={loops} disabled={performance} onChange={(e) => applyPatch({ loop: e.target.checked })} />
          Loop clip
        </label>
        {/* A performance is sung footage — only the footage layer offers it. */}
        {layer === 'footage' && (
          <>
            <label htmlFor={shotModeId} className="flex items-center gap-1">Shot</label>
            <select id={shotModeId} value={performance ? 'performance' : 'cutaway'}
              onChange={(e) => applyPatch({ shotMode: e.target.value })}
              className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] sm:min-h-0"
              title="Cutaway: any video lane animates the frame under the song. Performance: a singer lip-synced to the song itself (needs a source-audio provider).">
              <option value="cutaway">Cutaway</option>
              <option value="performance">Performance (lip-sync)</option>
            </select>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2 items-center text-xs">
        <label htmlFor={fieldId('layer')}>Layer</label>
        <select id={fieldId('layer')} value={layer} onChange={(e) => applyPatch({ visualLayer: e.target.value })}
          className="bg-port-bg border border-port-border rounded px-1 py-1">
          {MUSIC_VIDEO_VISUAL_LAYERS.map((value) => <option key={value} value={value}>{LAYER_LABELS[value]}</option>)}
        </select>
        {layer === 'still' && (
          <>
            <label htmlFor={fieldId('move')}>Move</label>
            <select id={fieldId('move')} value={scene.stillMove || 'hold'} onChange={(e) => applyPatch({ stillMove: e.target.value })}
              className="bg-port-bg border border-port-border rounded px-1 py-1">
              {STILL_MOVE_LABELS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </>
        )}
        {layer === 'card' && (
          <>
            <label htmlFor={fieldId('card-text')}>Card text</label>
            <input id={fieldId('card-text')} type="text" maxLength={500} value={scene.cardText || ''}
              placeholder="Title shown on the card"
              onChange={(e) => onEditLocal(scene.sceneId, { cardText: e.target.value })}
              onBlur={(e) => onSave(scene.sceneId, { cardText: e.target.value.trim() || null })}
              className="min-w-0 flex-1 basis-40 bg-port-bg border border-port-border rounded px-1 py-1" />
            <label htmlFor={fieldId('card-color')}>Background</label>
            <input id={fieldId('card-color')} type="color" value={scene.cardColor || '#000000'}
              onChange={(e) => onEditLocal(scene.sceneId, { cardColor: e.target.value })}
              onBlur={(e) => onSave(scene.sceneId, { cardColor: e.target.value })}
              className="h-8 w-10 bg-port-bg border border-port-border rounded" />
          </>
        )}
      </div>
      {layer !== 'footage' && !layered && (
        <p className="text-[11px] text-port-text-muted">
          {LAYER_LABELS[layer]} sections render in composed mode — a plain render plays this scene&apos;s footage.
        </p>
      )}
      {layer !== 'footage' && layered && !sceneHasAuthoredSpan(scene) && (
        <p role="alert" className="text-[11px] text-port-warning">
          Set a start and end — a {layer === 'card' ? 'title card' : 'still'} runs for exactly its span.
        </p>
      )}
      {performance && performanceBlocked && (
        <div role="alert" className="flex items-start gap-2 rounded border border-port-warning/40 bg-port-warning/10 px-2 py-1.5 text-xs text-port-warning">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span className="min-w-0 break-words">{performanceBlocked}</span>
        </div>
      )}
      {performance && !performanceBlocked && (
        <p className="text-[11px] text-port-text-muted break-words" data-testid="performance-plan">
          Lip-sync via {capability.label} ({capability.modelId}) · song {formatDurationSec(plan.windowStartSec)}–{formatDurationSec(plan.windowEndSec)}
          {plan.editInSec > 0 ? ` · shot starts ${plan.editInSec.toFixed(2)}s into the take` : ''} · {capability.costLabel}
        </p>
      )}
      {grokPlan && (
        <p className={`text-[11px] break-words ${grokPlan.needsSplit ? 'text-port-warning' : 'text-port-text-muted'}`}>
          Grok renders a {grokPlan.requestSec}s clip for this {timedSpan.toFixed(1)}s cutaway
          {grokPlan.needsSplit ? ` — ${grokPlan.uncoveredSec.toFixed(1)}s uncovered; split the scene rather than loop it` : ''}. Motion timing in the prompt is approximate.
        </p>
      )}
      {canSplit && onSplit && (
        <button type="button" onClick={() => onSplit(scene.sceneId, lipSyncBackend || null)}
          className="inline-flex items-center gap-1 rounded bg-port-bg border border-port-border hover:bg-port-border/40 px-2 py-1 text-xs min-h-[44px] sm:min-h-0"
          title={`Cut this ${timedSpan.toFixed(1)}s shot into scenes of at most ${splitLimit.toFixed(2)}s at lyric pauses or phrase boundaries — nothing is looped or stretched`}>
          <Scissors size={13} /> Split on lyric boundaries
        </button>
      )}
      {underCovered && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-port-warning/40 bg-port-warning/10 px-2 py-1.5 text-xs text-port-warning">
          <AlertTriangle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 basis-48">
            Shot runs {spanSec.toFixed(1)}s but its clip is {clipSec.toFixed(1)}s — the render won&apos;t repeat it.
            Trim the shot, continue or regenerate a longer clip, or loop it on purpose.
          </span>
          <button type="button" onClick={() => applyPatch({ endSec: Math.round((scene.startSec + clipSec) * 1000) / 1000 })}
            className="rounded bg-port-bg border border-port-border px-2 py-1 min-h-[44px] sm:min-h-0 text-port-text">Trim to clip</button>
          <button type="button" onClick={() => applyPatch({ loop: true })}
            className="rounded bg-port-bg border border-port-border px-2 py-1 min-h-[44px] sm:min-h-0 text-port-text">Loop clip</button>
        </div>
      )}
      {/* Reference frame — the still image that seeds this shot (Phase 1b) */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <textarea
          aria-label="Reference frame prompt"
          value={scene.framePrompt || ''} rows={2}
          onChange={(e) => onEditLocal(scene.sceneId, { framePrompt: e.target.value })}
          onBlur={(e) => onSave(scene.sceneId, { framePrompt: e.target.value || null })}
          placeholder="Reference frame prompt — the still that seeds this shot (defaults to the shot prompt)"
          className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
        />
        <div className="flex items-center gap-2">
          {scene.referenceImageId && (
            <button
              type="button"
              onClick={() => onOpenPreview?.(`image:${scene.referenceImageId}`)}
              aria-label={`View scene ${index + 1} reference frame full size`}
              title={`View scene ${index + 1} reference frame full size`}
              className="shrink-0 rounded border border-port-border overflow-hidden focus:outline-none focus:ring-2 focus:ring-port-accent"
            >
              <img
                src={`/data/images/${scene.referenceImageId}`}
                alt=""
                className="w-32 aspect-video object-cover block"
              />
            </button>
          )}
          <div className="flex flex-col gap-1">
            <button onClick={() => onGenerateFrame(scene)} disabled={!!generatingFrame}
              className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap"
              title={scene.referenceImageId
                ? 'Render another candidate frame — your selected frame stays until you pick a new one'
                : 'Generate a still reference frame for this scene'}>
              {generatingFrame ? <Activity size={14} className="animate-spin" /> : <ImageIcon size={14} />}
              {generatingFrame ? 'Generating frame…' : (scene.referenceImageId ? 'New frame take' : 'Generate frame')}
            </button>
            {onImportTake && (
              <button type="button" onClick={() => onImportTake(scene)} disabled={takeBusy}
                className="flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap"
                title="Add a frame from the gallery or an upload (e.g. made in an external tool) as a take">
                <ImagePlus size={14} /> Import take
              </button>
            )}
          </div>
        </div>
      </div>
      <SceneTakeStrip scene={scene} kind="image" busy={takeBusy}
        onSelect={(take) => onSelectTake?.(scene, take)}
        onReview={(take, review) => onReviewTake?.(scene, take, review)}
        onOpenPreview={onOpenPreview} />
      {/* Scene clip — i2v video generated from the reference frame (Phase 1) */}
      <div className="flex items-center gap-2 flex-wrap">
        {scene.videoHistoryId && (
          <div className="relative w-40 shrink-0">
            <video
              ref={clipPlayerRef}
              src={clipSrc}
              className="w-full aspect-video object-cover rounded border border-port-border bg-black"
              muted
              playsInline
              preload="metadata"
              controls
              onLoadedMetadata={(e) => {
                const sec = e.currentTarget.duration;
                if (Number.isFinite(sec) && sec > 0) setClipMeta({ id: scene.videoHistoryId, sec });
              }}
            />
            {/* Corner expand — do not put the open handler on <video> itself;
                that would fight native play/pause controls. Shape matches
                ScenePreview's open-in-new-tab overlay. Pause first so the
                lightbox's unmuted autoplay doesn't double-play the audio. */}
            <button
              type="button"
              onClick={() => {
                clipPlayerRef.current?.pause();
                onOpenPreview?.(`video:${scene.videoHistoryId}`);
              }}
              aria-label={`View scene ${index + 1} clip full size`}
              title={`View scene ${index + 1} clip full size`}
              className="always-dark absolute top-1 right-1 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 p-1 flex items-center justify-center rounded bg-black/50 text-white hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-port-accent"
            >
              <Maximize2 className="w-3 h-3" />
            </button>
          </div>
        )}
        <button onClick={() => onGenerateVideo(scene)}
          disabled={settingsSaving || !scene.referenceImageId || !!generatingVideo || !!videoBlockedReason || !!performanceBlocked}
          className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap"
          title={videoBlockedReason || performanceBlocked
            || (!scene.referenceImageId ? 'Generate a reference frame first'
              : performance ? `Lip-sync this scene's frame to the song via ${capability.label} — ${capability.costLabel}`
                : "Generate this scene's video from its reference frame (i2v)")}>
          {generatingVideo ? <Activity size={14} className="animate-spin" /> : <Video size={14} />}
          {generatingVideo ? 'Generating video…' : (scene.videoHistoryId ? 'New video take' : 'Generate video')}
        </button>
        {scene.videoHistoryId && canContinueShot && (
          <button
            onClick={() => onContinueVideo(scene)}
            disabled={settingsSaving || !!generatingVideo}
            className="flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap"
            title="Native-extend this clip from its final latent frames and attach the longer result to this scene"
          >
            <Video size={14} /> Continue shot
          </button>
        )}
        {onImportClipTake && (
          <button type="button" onClick={() => onImportClipTake(scene)} disabled={takeBusy}
            className="flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap"
            title="Pick an existing clip from the gallery (e.g. made in an external tool) as a take">
            <Clapperboard size={14} /> Import clip take
          </button>
        )}
      </div>
      <SceneTakeStrip scene={scene} kind="video" busy={takeBusy}
        onSelect={(take) => onSelectTake?.(scene, take)}
        onReview={(take, review) => onReviewTake?.(scene, take, review)}
        onOpenPreview={onOpenPreview} />
    </div>
  );
}
