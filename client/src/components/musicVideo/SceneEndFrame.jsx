import { Activity, Shuffle, Wand2, X } from 'lucide-react';
import SceneTakeStrip from './SceneTakeStrip.jsx';
import { sceneEndFramePlan } from '../../../../server/lib/musicVideoEndFrame.js';
import { falSceneTake } from '../../lib/musicVideoShotTiming.js';

const BUTTON = 'flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';

/**
 * Whether a clip rendered with `settings` (the project's saved renderer, or a
 * scene card's Render on pick merged over it) ends on the scene's end frame:
 * the same model the clip request is built with (useMusicVideoSceneMedia
 * generateSceneVideo), so a saved end-frame upgrade model counts. A local
 * clip's model (the pick, else the install default) decides whether it renders
 * first+last frame (#11258).
 */
export function sceneEndFramePlanFor(scene, settings = {}, { models = [], defaultModel = '' } = {}) {
  const mode = settings.generationMode === 'suppliedAudio' || (settings.backend === 'local' && settings.generationMode === 'audioReactive') ? 'a2v' : 'image';
  const falModelId = settings.backend === 'fal' ? falSceneTake({ scene, videoSettings: settings }).modelId : null;
  const localRuntime = settings.backend === 'local'
    ? models.find((model) => model.id === (settings.modelId || defaultModel))?.runtime ?? null
    : null;
  return sceneEndFramePlan(scene, { backend: settings.backend || null, falModelId, mode, localRuntime });
}

/**
 * A shot's end frame (#11173): the still its clip moves into from the start
 * frame, such as her head thrown back for a possession beat, or a pencil-sketch
 * rotoscope of the same frame. The director describes it and renders it from
 * the start frame, swaps one in from the unused stills, and picks among its
 * takes like any frame. Only renderers that take an end frame use it; the
 * Render section says whether the current pick does.
 */
export default function SceneEndFrame({
  scene, index, generating = false, onGenerate, onEditLocal, onSave, onOpenPreview,
  takeBusy = false, onSelectTake, onReviewTake, onSwap = null, disabled = false,
}) {
  const promptId = `mv-scene-${scene.sceneId}-end-frame-prompt`;
  const clear = () => { onEditLocal(scene.sceneId, { endImageId: null }); onSave(scene.sceneId, { endImageId: null }); };
  return (
    <div className="space-y-2">
      <label htmlFor={promptId} className="block text-[11px] text-port-text-muted">End frame prompt</label>
      <textarea
        id={promptId}
        value={scene.endFramePrompt || ''} rows={2}
        onChange={(e) => onEditLocal(scene.sceneId, { endFramePrompt: e.target.value })}
        onBlur={(e) => onSave(scene.sceneId, { endFramePrompt: e.target.value || null })}
        placeholder="Where the shot ends, e.g. her head thrown back, eyes white, lit from below"
        className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onGenerate?.(scene)}
          disabled={disabled || generating || !scene.referenceImageId || !scene.endFramePrompt?.trim()}
          title={!scene.referenceImageId ? 'Generate a start frame first'
            : !scene.endFramePrompt?.trim() ? 'Describe the end frame first'
              : "Render the end frame from this shot's start frame"}
          className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap">
          {generating ? <Activity size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {generating ? 'Generating end frame…' : (scene.endImageId ? 'New end frame take' : 'Generate end frame')}
        </button>
        {onSwap && (
          <button type="button" onClick={onSwap} disabled={disabled || takeBusy} className={BUTTON}
            title="Use a still made for this video that no shot uses as the end frame">
            <Shuffle size={14} /> Swap from unused
          </button>
        )}
        {scene.endImageId && (
          <button type="button" onClick={clear} disabled={disabled} className={BUTTON}
            aria-label={`Clear scene ${index + 1} end frame`} title="The clip ends where the model takes it; the end frame's takes stay">
            <X size={14} /> No end frame
          </button>
        )}
      </div>
      <p className="text-[11px] text-port-text-muted">The clip ends here on a fal.ai model marked &quot;ends on end frame&quot; under Render on.</p>
      <SceneTakeStrip scene={scene} kind="endImage" busy={takeBusy}
        onSelect={(take) => onSelectTake?.(scene, take)}
        onReview={(take, review) => onReviewTake?.(scene, take, review)}
        onOpenPreview={onOpenPreview} />
    </div>
  );
}
