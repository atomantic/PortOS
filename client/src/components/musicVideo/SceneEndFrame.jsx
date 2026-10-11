import { Activity, Wand2, X } from 'lucide-react';
import SceneTakeStrip from './SceneTakeStrip.jsx';
import { sceneEndFramePlan } from '../../../../server/lib/musicVideoEndFrame.js';

/**
 * A scene's optional style-break end frame (#11173): a still the clip moves
 * into from its photographic start frame, such as a pencil-sketch rotoscope or
 * a magazine-cutout collage. The director describes it, renders it from the
 * selected start frame, and picks among its takes like any frame. A fal clip on
 * a model that takes an end frame ends on it; the note says when the current
 * renderer will ignore it.
 */
export default function SceneEndFrame({
  scene, index, generating = false, onGenerate, onEditLocal, onSave, onOpenPreview,
  takeBusy = false, onSelectTake, onReviewTake, videoSettings = null,
}) {
  const settings = videoSettings || {};
  // Same mode the clip request is built with (useMusicVideoSceneMedia generateSceneVideo).
  const mode = settings.generationMode === 'suppliedAudio' || (settings.backend === 'local' && settings.generationMode === 'audioReactive') ? 'a2v' : 'image';
  const plan = sceneEndFramePlan(scene, { backend: settings.backend || null, falModelId: settings.falModelId || null, mode });
  const promptId = `mv-scene-${scene.sceneId}-end-frame-prompt`;
  return (
    <details className="rounded border border-port-border bg-port-bg/40 px-2 py-1.5" open={Boolean(scene.endImageId || scene.endFramePrompt)}>
      <summary className="cursor-pointer text-xs text-port-text-muted min-h-[44px] sm:min-h-0 flex items-center">
        End frame (style break){scene.endImageId ? ' · set' : ''}
      </summary>
      <div className="mt-2 space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="flex-1 min-w-0">
            <label htmlFor={promptId} className="sr-only">End frame prompt</label>
            <textarea
              id={promptId}
              value={scene.endFramePrompt || ''} rows={2}
              onChange={(e) => onEditLocal(scene.sceneId, { endFramePrompt: e.target.value })}
              onBlur={(e) => onSave(scene.sceneId, { endFramePrompt: e.target.value || null })}
              placeholder="What the last frame becomes, e.g. the same frame as a pencil-sketch rotoscope"
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            {scene.endImageId && (
              <div className="relative shrink-0">
                <button type="button" onClick={() => onOpenPreview?.(`image:${scene.endImageId}`)}
                  aria-label={`View scene ${index + 1} end frame full size`}
                  className="block rounded border border-port-border overflow-hidden focus:outline-none focus:ring-2 focus:ring-port-accent">
                  <img src={`/data/images/${encodeURIComponent(scene.endImageId)}`} alt="" className="w-32 aspect-video object-cover block" />
                </button>
                <button type="button" onClick={() => { onEditLocal(scene.sceneId, { endImageId: null }); onSave(scene.sceneId, { endImageId: null }); }}
                  aria-label={`Clear scene ${index + 1} end frame`} title="Clear the end frame (its takes stay)"
                  className="always-dark absolute top-1 right-1 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 p-1 flex items-center justify-center rounded bg-black/50 text-white hover:bg-black/80">
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
            <button type="button" onClick={() => onGenerate?.(scene)}
              disabled={generating || !scene.referenceImageId || !scene.endFramePrompt?.trim()}
              title={!scene.referenceImageId ? 'Generate a reference frame first'
                : !scene.endFramePrompt?.trim() ? 'Describe the end frame first'
                  : 'Render the end frame from this scene\'s selected start frame'}
              className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap">
              {generating ? <Activity size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {generating ? 'Generating end frame…' : (scene.endImageId ? 'New end frame take' : 'Generate end frame')}
            </button>
          </div>
        </div>
        {scene.endImageId && (
          <p className={`text-[11px] ${plan.used ? 'text-port-text-muted' : 'text-port-warning'}`}>
            {plan.used ? 'The clip ends on this frame.' : plan.reason}
          </p>
        )}
        <SceneTakeStrip scene={scene} kind="endImage" busy={takeBusy}
          onSelect={(take) => onSelectTake?.(scene, take)}
          onReview={(take, review) => onReviewTake?.(scene, take, review)}
          onOpenPreview={onOpenPreview} />
      </div>
    </details>
  );
}
