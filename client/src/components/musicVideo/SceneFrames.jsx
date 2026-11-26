import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, ArrowRight } from 'lucide-react';
import { musicVideoGreyboxReference } from '../../../../server/lib/musicVideo/musicVideoGreybox.js';
import { resolveSourceTake } from '../../../../server/lib/musicVideo/musicVideoSourceTake.js';
import { shotSheetDrivesPrompt } from '../../../../server/lib/musicVideo/musicVideoShotSheet.js';
import SceneFrameRenderTarget, { frameRenderProjectLabel, frameRenderTargetOverrides, lastFrameRenderTarget } from './SceneFrameRenderTarget.jsx';
import SceneCameoLink from './SceneCameoLink.jsx';
import SceneFrameReferences from './SceneFrameReferences.jsx';
import SceneResearchSeed from './SceneResearchSeed.jsx';
import SceneGreyboxReference from './SceneGreyboxReference.jsx';
import SceneFrameColumn from './SceneFrameColumn.jsx';
import { sceneButtonClass as SECONDARY_BUTTON } from './controlClasses.js';

/**
 * A shot's frames: the still its clip starts from and, for footage, the
 * optional one it ends on (#11173). Each frame shows its prompt and its own
 * Render right under the picture, and can render from the start or end frame
 * as an image reference (`onGenerateFrame` / `onGenerateEndFrame` take
 * `{ referenceImageId }`, null for prompt only). Render on names the image
 * service for this shot's frames only; a pick rides along as `imageTarget`.
 * Refine edits a frame by a
 * short instruction (`{ referenceImageId, refine }`), and Swap puts one of the
 * video's unused stills on it. Each frame's own takes sit under it as a grid,
 * so both frames' actions and takes show at once; tapping a frame opens it full size.
 * With both frames set, `onSwapFrames` trades them (prompts included) in one tap.
 * The References row above them picks the character and set references every frame render sends;
 * Research and seed above it imports real photos of the shot's subject that lead those references.
 * With `endFrameToggle` (footage, and a still whose picture is an end-frame effect),
 * Use end frame switches the end frame off (`scene.endFrameOff`): its column hides and
 * the shot plays its start frame only, keeping its selection, prompt and takes for switching back on.
 * `shown` false (the shot editor is on its clip view) holds the frame prompt previews until the frames show.
 */
export default function SceneFrames({
  project, castMedia, onReloadCastMedia, greyboxPlaces, greyboxSaving, onGreyboxSaving, scene, index,
  endFrames: endFramesAllowed, endFrameToggle, plainStill, generatingFrame, generatingEndFrame,
  onGenerateFrame, onGenerateEndFrame, onImageTargetChange, onEditLocal, onSave, onOpenPreview, shown = true,
  takeBusy, pendingTakes, onSelectTake, onReviewTake, onSwap, onImportTake, onContinueFromPrevious,
  previousHasClip, onSwapFrames, assetMarks, onMarkTake, onMoveTake, onCheckTake, checkingTakes, onApplyCameos,
}) {
  const endFrameOff = endFrameToggle && (plainStill || scene.endFrameOff === true);
  const endFrames = endFramesAllowed && !endFrameOff;
  // A detail-built shot: its frame prompt is the still's general prompt and the shot details are composed in.
  const fromSheet = shotSheetDrivesPrompt(scene);
  const setEndFrameOn = (on) => {
    const patch = { endFrameOff: on ? null : true, ...(on && plainStill ? { visualLayer: 'still', imageEffect: 'end-fade', imageEffectSec: null } : {}) };
    onEditLocal(scene.sceneId, patch);
    onSave(scene.sceneId, patch);
  };
  const greybox = musicVideoGreyboxReference(project, scene, greyboxPlaces);
  const [referenceSaving, setReferenceSaving] = useState(false);
  // The greybox card stays folded away behind its checkbox unless the shot uses a greybox.
  const hasGreyboxSets = Boolean(scene.setReference) || (project?.concept?.subjects || []).some((s) => s.kind === 'place' && s.ingredientId);
  const [greyboxOpen, setGreyboxOpen] = useState(false);
  const greyboxOn = greyboxOpen || Boolean(scene.setReference);
  const markGreyboxSaving = (saving) => { setReferenceSaving(saving); onGreyboxSaving?.(saving); };
  const saveGreybox = async (setReference) => {
    const saved = await onSave(scene.sceneId, { setReference });
    if (saved !== false) onEditLocal(scene.sceneId, { setReference });
    return saved;
  };
  const greyboxBlocked = greyboxSaving || referenceSaving || Boolean(greybox?.error);
  const [keepStillAsEnd, setKeepStillAsEnd] = useState(false);
  // Which frame each render starts from: the start frame renders from its prompt, the end frame from the start frame.
  const [refs, setRefs] = useState({ start: '', end: 'start' });
  // Refine: which frame's edit box is open, and the instruction typed into it.
  const [refining, setRefining] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [includeReferences, setIncludeReferences] = useState(true);
  const [editWith, setEditWith] = useState('');
  const openRefine = (which, imageId) => {
    setRefining((current) => current?.which === which && current.imageId === imageId ? null : { which, imageId });
    setInstruction('');
    setIncludeReferences(true);
  };
  // Refine take sits in the take strip below the form, so opening it brings the instruction box into view and focus.
  const refineInputRef = useRef(null);
  useEffect(() => {
    const input = refineInputRef.current;
    if (!refining || !input) return;
    input.focus({ preventScroll: true });
    input.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [refining]);
  // A return shows the source shot's frame and does not render one of its own.
  const sourceWindow = resolveSourceTake(scene, project?.scenes);
  const frames = {
    start: sourceWindow?.referenceImageId || scene.referenceImageId || null,
    end: endFrames ? scene.endImageId || null : null,
  };
  const id = (name) => `mv-scene-${scene.sceneId}-${name}`;
  // '' follows the project image pin. A named service is this render only, and stays for Retry.
  const [framePick, setFramePick] = useState(() => lastFrameRenderTarget().pick);
  const [frameOptions, setFrameOptions] = useState(() => lastFrameRenderTarget().options);
  const imageTarget = useMemo(() => frameRenderTargetOverrides(framePick, frameOptions), [framePick, frameOptions]);
  useEffect(() => { onImageTargetChange?.(imageTarget); }, [imageTarget, onImageTargetChange]);

  // Keep this override out of the device's remembered picker and SceneCard's Retry/Clip actions.
  const [takeModel, setTakeModel] = useState(null);
  const framesDefaultLabel = frameRenderProjectLabel(framePick ? { imageMode: framePick, imageModelId: frameOptions.modelId } : project);

  const columnProps = {
    project, scene, index, endFrames, fromSheet, frames, sourceWindow, id, castMedia, greybox, greyboxBlocked, shown,
    onEditLocal, onSave, onOpenPreview,
    rendering: { refs, setRefs, imageTarget, takeModel, setTakeModel, framesDefaultLabel },
    refine: {
      refining, openRefine, instruction, setInstruction, includeReferences, setIncludeReferences, editWith, setEditWith,
      refineInputRef, finish: () => { setRefining(null); setInstruction(''); },
    },
    takes: {
      busy: takeBusy, pendingTakes, onSelectTake, onReviewTake, onSwap, onImportTake,
      onContinueFromPrevious, previousHasClip, keepStillAsEnd, setKeepStillAsEnd,
      assetMarks, onMarkTake, onCheckTake, checkingTakes, onMoveTake,
    },
  };
  const startColumn = <SceneFrameColumn {...columnProps} which="start" generating={generatingFrame} onGenerate={onGenerateFrame} />;

  return (
    <section aria-label="Still" className="@container min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-medium">{endFrames ? 'Frames' : 'Still'}</h4>
        {endFramesAllowed && endFrameToggle && (
          <label htmlFor={id('use-end-frame')} className="flex items-center gap-1 text-xs text-port-text-muted min-h-[44px] pointer-fine:sm:min-h-0"
            title="Off hides the end frame and clips start from the start frame only; its takes and prompt stay">
            <input id={id('use-end-frame')} type="checkbox" checked={!endFrameOff} onChange={(e) => setEndFrameOn(e.target.checked)} />
            Use end frame
          </label>
        )}
      </div>
      <SceneFrameRenderTarget id={id('frame-render')} value={framePick} options={frameOptions} project={project}
        editing={refining != null} disabled={!!generatingFrame || !!generatingEndFrame} onChange={setFramePick} onOptionsChange={setFrameOptions} />
      <SceneCameoLink project={project} scene={scene} onApplyCameos={onApplyCameos} onEditLocal={onEditLocal} onSave={onSave} />
      {project && <SceneResearchSeed project={project} scene={scene} onEditLocal={onEditLocal} onSave={onSave} />}
      <SceneFrameReferences project={project} scene={scene} castMedia={castMedia} onReloadCastMedia={onReloadCastMedia} greybox={greybox} onEditLocal={onEditLocal} onSave={onSave} />
      {hasGreyboxSets && (
        <label htmlFor={id('greybox')} className="flex items-center gap-1 text-xs text-port-text-muted min-h-[44px] pointer-fine:sm:min-h-0"
          title={scene.setReference ? 'Off removes this shot\'s greybox set and camera reference' : 'Pick a greybox set and camera to send as a layout reference'}>
          <input id={id('greybox')} type="checkbox" checked={greyboxOn} disabled={greyboxSaving || referenceSaving}
            onChange={(e) => { setGreyboxOpen(e.target.checked); if (!e.target.checked && scene.setReference) { markGreyboxSaving(true); Promise.resolve(saveGreybox(null)).finally(() => markGreyboxSaving(false)); } }} />
          Greybox layout
        </label>
      )}
      {greyboxOn && (
        <SceneGreyboxReference project={project} scene={scene} places={greyboxPlaces} onSaving={markGreyboxSaving} onChange={saveGreybox} />
      )}
      {endFrames ? (
        <div role="group" aria-label="Start and end frames" className="grid gap-3 @sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          {startColumn}
          <ArrowRight size={14} aria-hidden="true" className="hidden self-start text-port-text-muted @sm:mt-12 @sm:block" />
          <SceneFrameColumn {...columnProps} which="end" generating={generatingEndFrame} onGenerate={onGenerateEndFrame} />
        </div>
      ) : startColumn}
      {endFrames && onSwapFrames && frames.start && frames.end && (
        <button type="button" onClick={onSwapFrames} disabled={takeBusy} className={SECONDARY_BUTTON}
          title="The start frame becomes the end frame and the end frame the start, each with its prompt">
          <ArrowLeftRight size={14} /> Swap start and end
        </button>
      )}
    </section>
  );
}
