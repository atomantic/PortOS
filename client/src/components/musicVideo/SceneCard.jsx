import { useRef } from 'react';
import { Trash2, Activity, ArrowUp, ArrowDown, Image as ImageIcon, Video, Maximize2 } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';

// The two timeline-bound scene fields rendered as identical number inputs.
const SCENE_TIME_FIELDS = [['Start', 'startSec'], ['End', 'endSec']];

/**
 * One scene on the board: ordering/delete, the shot + reference-frame prompts
 * (optimistic local edit, PATCH on blur), the authored timeline span, and the
 * per-scene reference-frame / clip render controls.
 *
 * `onOpenPreview(key)` opens the page-level MediaLightbox for a frame
 * (`image:<filename>`) or clip (`video:<historyId>`). The frame thumb is the
 * whole button; the clip keeps native play/pause and uses a corner expand
 * control so the open handler never fights the player.
 */
export default function SceneCard({
  scene, index, isLast, generatingFrame, generatingVideo,
  settingsSaving, videoBlockedReason, canContinueShot,
  onMove, onDelete, onEditLocal, onSave,
  onGenerateFrame, onGenerateVideo, onContinueVideo,
  onOpenPreview,
}) {
  // Pause the inline clip before opening the lightbox so the user can't hear
  // two desynced copies — MediaLightbox autoplays unmuted, and the thumb's
  // native controls let the user unmute it first (muted is only initial).
  const clipPlayerRef = useRef(null);
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
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onMove(index, -1)} disabled={index === 0} aria-label="Move up" className="p-1 disabled:opacity-30" title="Move up"><ArrowUp size={14} /></button>
          <button onClick={() => onMove(index, 1)} disabled={isLast} aria-label="Move down" className="p-1 disabled:opacity-30" title="Move down"><ArrowDown size={14} /></button>
          <button onClick={() => onDelete(scene.sceneId)} aria-label="Delete scene" className="p-1 text-port-error" title="Delete scene"><Trash2 size={14} /></button>
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
      </div>
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
          <button onClick={() => onGenerateFrame(scene)} disabled={!!generatingFrame}
            className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap"
            title="Generate a still reference frame for this scene">
            {generatingFrame ? <Activity size={14} className="animate-spin" /> : <ImageIcon size={14} />}
            {generatingFrame ? 'Generating frame…' : (scene.referenceImageId ? 'Regenerate frame' : 'Generate frame')}
          </button>
        </div>
      </div>
      {/* Scene clip — i2v video generated from the reference frame (Phase 1) */}
      <div className="flex items-center gap-2 flex-wrap">
        {scene.videoHistoryId && (
          <div className="relative w-40 shrink-0">
            <video
              ref={clipPlayerRef}
              src={`/data/videos/${scene.videoHistoryId}.mp4`}
              className="w-full aspect-video object-cover rounded border border-port-border bg-black"
              muted
              playsInline
              preload="metadata"
              controls
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
          disabled={settingsSaving || !scene.referenceImageId || !!generatingVideo || !!videoBlockedReason}
          className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap"
          title={videoBlockedReason
            || (scene.referenceImageId ? "Generate this scene's video from its reference frame (i2v)" : 'Generate a reference frame first')}>
          {generatingVideo ? <Activity size={14} className="animate-spin" /> : <Video size={14} />}
          {generatingVideo ? 'Generating video…' : (scene.videoHistoryId ? 'Regenerate video' : 'Generate video')}
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
      </div>
    </div>
  );
}
