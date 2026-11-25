import { castLookForTake } from '../../../../server/lib/musicVideo/musicVideoCastLook.js';
import { musicVideoGreyboxReference } from '../../../../server/lib/musicVideo/musicVideoGreybox.js';
import { resolveSourceTake } from '../../../../server/lib/musicVideo/musicVideoSourceTake.js';
import SceneFramePromptPreview from './SceneFramePromptPreview.jsx';
import SceneFrameReferenceLimitNotice from './SceneFrameReferenceLimitNotice.jsx';
import SceneGreyboxReference from './SceneGreyboxReference.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowLeftRight, ArrowRight, Image as ImageIcon, ImagePlus, PencilLine, Shuffle, SkipForward, Wand2, X } from 'lucide-react';
import AutoSizeTextarea from '../ui/AutoSizeTextarea.jsx';
import BlurCommitTextarea from '../ui/BlurCommitTextarea.jsx';
import InfoTooltip from '../ui/InfoTooltip';
import SceneFrameRenderTarget, { frameRenderProjectLabel, frameRenderTargetOverrides, lastFrameRenderTarget } from './SceneFrameRenderTarget.jsx';
import SceneTakeStrip from './SceneTakeStrip.jsx';
import SceneCameoLink from './SceneCameoLink.jsx';
import SceneFrameReferences from './SceneFrameReferences.jsx';
import SceneResearchSeed from './SceneResearchSeed.jsx';
import { shotImageUrl } from './sceneImageTreatmentUrls.js';
import { shotSheetDrivesPrompt } from '../../../../server/lib/musicVideo/musicVideoShotSheet.js';
import { FAL_FEATURED_EDIT_MODEL_IDS, FAL_IMAGE_MODEL_OPTIONS } from '../../lib/imageGenBackends';

const PRIMARY_BUTTON = 'flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] pointer-fine:sm:min-h-0 whitespace-nowrap';
const SECONDARY_BUTTON = 'flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] pointer-fine:sm:min-h-0 whitespace-nowrap';
const SELECT = 'min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50';

/** One of a shot's two frames: tap it to see it full size. */
function FrameTile({ label, imageId, src, empty, onOpen, openLabel }) {
  const tag = <span className="port-media-overlay-strong absolute left-1 top-1 rounded px-1 text-[10px] leading-tight">{label}</span>;
  if (!imageId) {
    return (
      <div className="relative min-w-0 overflow-hidden rounded border border-dashed border-port-border">
        <span className="flex aspect-video w-full items-center justify-center text-[11px] text-port-text-muted">{empty}</span>
        {tag}
      </div>
    );
  }
  return (
    <button type="button" onClick={onOpen} aria-label={openLabel} title={openLabel}
      className="relative block w-full min-w-0 overflow-hidden rounded border border-port-border focus:outline-none focus:ring-2 focus:ring-port-accent">
      <img src={src || `/data/images/${encodeURIComponent(imageId)}`} alt="" className="block aspect-video w-full bg-black object-cover" />
      {tag}
    </button>
  );
}

// A shot's frame prompt and its Clip tab's clip prompt are stored apart, so each box names the model it feeds.
const FRAME_PROMPT_HELP = 'What this frame shows. The image model renders it from this text plus the additions listed under it. What happens in the shot is the clip prompt on the Clip tab.';
const GENERAL_PROMPT_HELP = 'Anything the shot details don\'t cover. The frame\'s prompt is this text plus each shot detail, listed under it as its own part; what happens in the shot is the clip prompt on the Clip tab.';

function FramePrompt({ id, label, value, help = FRAME_PROMPT_HELP, ...props }) {
  return (
    <>
      <div className="flex items-center gap-1 text-[11px] text-port-text-muted">
        <label htmlFor={id}>{label}</label>
        <InfoTooltip label={`About the ${label.toLowerCase()}`} placement="below" align="start" width={280}>{help}</InfoTooltip>
      </div>
      <BlurCommitTextarea id={id} value={value} rows={3} {...props}
        className="block w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm" />
    </>
  );
}

const REFERENCE_LABELS = { '': 'Prompt only', start: 'Start frame', end: 'End frame' };
const REFINE_EDIT_MODELS = FAL_FEATURED_EDIT_MODEL_IDS
  .map((id) => FAL_IMAGE_MODEL_OPTIONS.find((row) => row.id === id))
  .filter(Boolean);
// Both render from the current prompt and Casting look; only Re-render replaces the selected frame (takes.js `replaceSelection`).
const NEW_TAKE_HINT = 'Renders another candidate and adds it to the takes below. The frame in use stays selected until you pick a new take.';
const RERENDER_HINT = 'Renders this frame again from the current Casting look and swaps it in as the selected frame. The old frame stays in the takes.';

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
  project = null, castMedia = null, onReloadCastMedia = null, greyboxPlaces = {}, greyboxSaving = false, onGreyboxSaving, scene, index, endFrames: endFramesAllowed, endFrameToggle = false, plainStill = false, generatingFrame = false, generatingEndFrame = false, onGenerateFrame, onGenerateEndFrame, onImageTargetChange = null,
  onEditLocal, onSave, onOpenPreview, shown = true, takeBusy = false, pendingTakes = null, onSelectTake, onReviewTake, onSwap = null, onImportTake = null,
  onContinueFromPrevious = null, previousHasClip = false, onSwapFrames = null, assetMarks = null, onMarkTake = null, onMoveTake = null, onCheckTake = null, checkingTakes = null, onApplyCameos = null,
}) {
  const endFrameOff = endFrameToggle && (plainStill || scene.endFrameOff === true);
  const endFrames = endFramesAllowed && !endFrameOff;
  // A detail-built shot: its frame prompt is the still's general prompt and the shot details are composed in.
  const fromSheet = shotSheetDrivesPrompt(scene);
  const setEndFrameOn = (on) => { const patch = { endFrameOff: on ? null : true, ...(on && plainStill ? { visualLayer: 'still', imageEffect: 'end-fade', imageEffectSec: null } : {}) }; onEditLocal(scene.sceneId, patch); onSave(scene.sceneId, patch); };
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
  const refOf = (which) => (frames[refs[which]] ? refs[which] : '');
  const id = (name) => `mv-scene-${scene.sceneId}-${name}`;
  // '' follows the project image pin. A named service is this render only, and stays for Retry.
  const [framePick, setFramePick] = useState(() => lastFrameRenderTarget().pick);
  const [frameOptions, setFrameOptions] = useState(() => lastFrameRenderTarget().options);
  const imageTarget = useMemo(() => frameRenderTargetOverrides(framePick, frameOptions), [framePick, frameOptions]);
  useEffect(() => { onImageTargetChange?.(imageTarget); }, [imageTarget, onImageTargetChange]);
  const withTarget = (extra) => (imageTarget ? { ...extra, imageTarget } : extra);

  // Keep this override out of the device's remembered picker and SceneCard's Retry/Clip actions.
  const [takeModel, setTakeModel] = useState(null);
  const framesDefaultLabel = frameRenderProjectLabel(framePick ? { imageMode: framePick, imageModelId: frameOptions.modelId } : project);

  const column = (which) => {
    const start = which === 'start';
    const label = start ? (endFrames ? 'Start' : 'Still') : 'End';
    const field = start ? 'framePrompt' : 'endFramePrompt';
    const generating = start ? generatingFrame : generatingEndFrame;
    const imageId = frames[which];
    const ref = refOf(which);
    const refChoices = ['', ...['start', 'end'].filter((key) => frames[key])];
    const needsPrompt = !start && !scene.endFramePrompt?.trim();
    const sharedTake = !!sourceWindow;
    const blocked = sharedTake || greyboxBlocked || generating || needsPrompt;
    const oneTake = takeModel?.which === which ? takeModel : null;
    const renderTarget = frameRenderTargetOverrides(oneTake?.pick, oneTake?.options) || imageTarget;
    const render = () => {
      if (blocked) return;
      const payload = { referenceImageId: ref ? frames[ref] : null, ...(renderTarget ? { imageTarget: renderTarget } : {}) };
      (start ? onGenerateFrame : onGenerateEndFrame)?.(scene, payload);
      if (oneTake) setTakeModel(null);
    };
    const kind = start ? 'image' : 'endImage';
    const selected = imageId ? (scene.takes || []).find((take) => take?.kind === kind && take.assetId === imageId) : null;
    // The server's warning (#16473) covers every character reference the record knows; Casting guides are read here.
    const olderCharacter = selected?.characterReferenceState || null;
    const olderLook = Boolean(olderCharacter) || (selected ? castLookForTake(project, scene, selected, castMedia).status === 'older' : false);
    const rerender = () => {
      if (sharedTake || greyboxBlocked || generating || needsPrompt) return;
      (start ? onGenerateFrame : onGenerateEndFrame)?.(scene, withTarget({ referenceImageId: ref ? frames[ref] : null, replaceSelection: true }));
    };
    const refineLocked = sharedTake || (includeReferences && greyboxBlocked) || !!generating || takeBusy;
    const refineImageId = refining?.which === which ? refining.imageId : null;
    const refine = (e) => {
      e.preventDefault();
      if (!instruction.trim() || !refineImageId || refineLocked) return;
      const payload = { referenceImageId: refineImageId, refine: instruction, ...(includeReferences ? {} : { includeReferences: false }) };
      const base = withTarget(payload);
      // A fal Render on already leads its model list with these edit endpoints.
      // Any other renderer offers them here, and a pick sends only this refine to that model.
      const editTarget = framePick !== 'fal' && editWith ? { mode: 'fal', cloudModel: editWith } : null;
      (start ? onGenerateFrame : onGenerateEndFrame)?.(scene, editTarget ? { ...base, imageTarget: editTarget } : base);
      setRefining(null);
      setInstruction('');
    };
    return (
      <div key={which} className="min-w-0 space-y-1.5">
        <FrameTile label={label} imageId={imageId} src={imageId ? shotImageUrl(project?.id, scene, imageId) : null} empty={start ? 'No still yet' : 'Optional'} onOpen={() => onOpenPreview?.(`image:${imageId}`)}
          openLabel={`View scene ${index + 1} ${start ? 'reference' : 'end'} frame full size`} />
        <FramePrompt id={id(`${which}-prompt`)} label={start ? (fromSheet ? 'General frame prompt' : endFrames ? 'Start frame prompt' : 'Frame prompt') : 'End frame prompt'} value={scene[field] || ''}
          help={start && fromSheet ? GENERAL_PROMPT_HELP : FRAME_PROMPT_HELP}
          onCommit={(text) => onEditLocal(scene.sceneId, { [field]: text })}
          onBlur={(e) => onSave(scene.sceneId, { [field]: e.target.value || null })}
          placeholder={start ? (fromSheet ? 'Anything the shot details don\'t cover' : 'What the frame shows (empty: uses the clip prompt)') : 'Where the shot ends, e.g. her head thrown back, eyes white'} />
        {/* What the frame sends: its prompt plus every addition, as chips. */}
        {project && <SceneFramePromptPreview project={project} scene={scene} castMedia={castMedia} greybox={greybox} slot={which} referenceImageId={ref ? frames[ref] : null} enabled={shown} imageTarget={renderTarget} />}
        {project && <SceneFrameReferenceLimitNotice project={project} scene={scene} castMedia={castMedia} greybox={greybox} sourceImageId={ref ? frames[ref] : null} />}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={render} disabled={blocked} className={PRIMARY_BUTTON}
            title={sharedTake ? `Plays ${sourceWindow.source?.label || 'the source shot'}'s frame` : needsPrompt ? 'Describe the end frame first' : imageId ? NEW_TAKE_HINT : ref ? `Render from the ${REFERENCE_LABELS[ref].toLowerCase()} with this prompt` : 'Render from this prompt'}>
            {generating ? <Activity size={14} className="animate-spin" /> : start ? <ImageIcon size={14} /> : <Wand2 size={14} />}
            {generating ? 'Generating…' : start ? (imageId ? 'New frame take' : 'Generate frame') : (imageId ? 'New end frame take' : 'Generate end frame')}
          </button>
          {!sharedTake && imageId && (
            <button type="button" className={SECONDARY_BUTTON} disabled={!!generating} aria-expanded={!!oneTake}
              aria-controls={id(`${which}-take-model`)} aria-label={`Image model for this ${start ? (endFrames ? 'start frame' : 'frame') : 'end frame'} take`}
              onClick={() => setTakeModel(oneTake ? null : { which, pick: '', options: {} })}>
              Image model for this take
            </button>
          )}
          {olderLook && (
            <button type="button" onClick={rerender} disabled={sharedTake || greyboxBlocked || !!generating || needsPrompt} className={SECONDARY_BUTTON}
              aria-label={`Re-render ${start ? 'start' : 'end'} frame`}
              title={RERENDER_HINT}>
              Re-render
            </button>
          )}
          {imageId && (
            <InfoTooltip label={olderLook ? 'New take vs Re-render' : 'About new takes'} placement="below" align="start" width={280}>
              <strong>{start ? 'New frame take' : 'New end frame take'}:</strong> {NEW_TAKE_HINT}
              {olderLook && <><br /><strong>Re-render:</strong> {RERENDER_HINT}</>}
            </InfoTooltip>
          )}
          {refChoices.length > 1 && (
            <span className="flex min-w-0 items-center gap-1">
              <label htmlFor={id(`${which}-from`)} className="text-xs text-port-text-muted">From</label>
              <select id={id(`${which}-from`)} value={ref} onChange={(e) => setRefs((prev) => ({ ...prev, [which]: e.target.value }))}
                disabled={!!generating} className={SELECT} title="Use a frame as the image reference for this render">
                {refChoices.map((key) => <option key={key} value={key}>{REFERENCE_LABELS[key]}</option>)}
              </select>
            </span>
          )}
          {imageId && (
            <button type="button" onClick={() => openRefine(which, imageId)} disabled={sharedTake || !!generating || takeBusy}
              aria-expanded={refineImageId === imageId} className={SECONDARY_BUTTON} title="Edit this frame with a short instruction, keeping the rest">
              <PencilLine size={14} /> Refine
            </button>
          )}
          {onSwap && (
            <button type="button" onClick={() => onSwap(start ? 'image' : 'endImage')} disabled={takeBusy} className={SECONDARY_BUTTON}
              aria-label={`Swap ${start ? 'start' : 'end'} frame from unused`}
              title={`Pick a still made for this video that no shot uses as the ${start ? 'start' : 'end'} frame`}>
              <Shuffle size={14} /> Swap
            </button>
          )}
        </div>
        {oneTake && !sharedTake && imageId && (
          <div role="group" aria-label="One-take image model" className="min-w-0 space-y-1 rounded border border-port-border p-2" id={id(`${which}-take-model`)}>
            <SceneFrameRenderTarget id={id(`${which}-take-render`)} value={oneTake.pick} options={oneTake.options} project={project}
              remember={false} defaultOption={`Current frame setting · ${framesDefaultLabel}`} disabled={!!generating}
              onChange={(pick) => setTakeModel((current) => ({ ...current, pick }))}
              onOptionsChange={(options) => setTakeModel((current) => ({ ...current, options }))} />
            <p className="text-xs text-port-text-muted">Only the next new {start ? 'frame' : 'end frame'} take uses this choice.</p>
          </div>
        )}
        {olderLook && (
          <p className="text-xs text-port-text-muted">{olderCharacter
            ? `${olderCharacter.reasons.join(' · ')}. Re-render to use the current reference, or keep it with Still matches on the take.`
            : 'Older look: Casting changed since this was rendered. Re-render to use the new look.'}</p>
        )}
        {refineImageId && (<>
          <form onSubmit={refine} className="min-w-0 space-y-2 rounded border border-port-border p-2">
            {refineImageId !== imageId && <FrameTile label="Refining this take" imageId={refineImageId}
              onOpen={() => onOpenPreview?.(`image:${refineImageId}`)} openLabel="View refinement source full size" />}
            <p className="text-xs text-port-text-muted">Creates a new take. The frame in use stays selected.</p>
            <div className="flex min-w-0 gap-2">
              <label htmlFor={id(`${which}-refine`)} className="sr-only">{`What to change in the ${start ? 'start' : 'end'} frame`}</label>
              <AutoSizeTextarea ref={refineInputRef} id={id(`${which}-refine`)} rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)}
                placeholder="What to change, e.g. remove the hand"
                className="min-w-0 flex-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-base sm:text-sm" />
              <button type="submit" disabled={!instruction.trim() || refineLocked} className={PRIMARY_BUTTON}
                aria-label={`Render refined ${start ? 'start' : 'end'} frame`}>
                <Wand2 size={14} /> Render
              </button>
            </div>
            <SceneFrameRenderTarget id={id(`${which}-refine-render`)} value={framePick} options={frameOptions} project={project}
              disabled={!!generatingFrame || !!generatingEndFrame} onChange={setFramePick} onOptionsChange={setFrameOptions} />
            <label htmlFor={id(`${which}-refine-references`)} className="flex items-center gap-2 text-xs min-h-[44px] pointer-fine:sm:min-h-0">
              <input id={id(`${which}-refine-references`)} type="checkbox" checked={includeReferences} onChange={(e) => setIncludeReferences(e.target.checked)} />
              Include shot reference images
            </label>
            <p className="text-xs text-port-text-muted">{includeReferences ? 'Sends this image plus the shot’s references, including mood-board and greybox images.' : 'Sends only the image to refine with your instruction.'}</p>
            {framePick !== 'fal' && (
              <div className="flex min-w-0 items-center gap-2">
                <label htmlFor={id(`${which}-edit-with`)} className="shrink-0 text-xs text-port-text-muted">Edit with</label>
                <select id={id(`${which}-edit-with`)} value={editWith} onChange={(e) => setEditWith(e.target.value)}
                  disabled={refineLocked} className={`${SELECT} min-w-0 flex-1`} title="Featured fal.ai edit models for this refine. Current image render keeps the shot's renderer.">
                  <option value="">Current image render</option>
                  {REFINE_EDIT_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </div>
            )}
            {project && <SceneFramePromptPreview project={project} scene={scene} slot={which} referenceImageId={refineImageId} instruction={instruction} includeReferences={includeReferences} enabled={shown}
              imageTarget={framePick !== 'fal' && editWith ? { mode: 'fal', cloudModel: editWith } : imageTarget} />}
          </form>
          {project && includeReferences && <SceneFrameReferenceLimitNotice project={project} scene={scene} castMedia={castMedia} greybox={greybox} sourceImageId={refineImageId} />}
        </>)}
        {(start ? onImportTake || onContinueFromPrevious : scene.endImageId) && (
          <div className="flex flex-wrap gap-2">
            {start && onImportTake && (
              <button type="button" onClick={() => onImportTake(scene)} disabled={takeBusy} className={SECONDARY_BUTTON}
                title="Add a frame from the gallery or an upload (e.g. made in an external tool) as a take">
                <ImagePlus size={14} /> Import take
              </button>
            )}
            {start && onContinueFromPrevious && (
              <button type="button" onClick={() => onContinueFromPrevious(scene, { keepStillAsEnd: keepStillAsEnd && Boolean(scene.referenceImageId) })}
                disabled={takeBusy || !previousHasClip} className={SECONDARY_BUTTON}
                title={previousHasClip ? 'Start this shot from the last frame the previous shot shows in the cut' : 'The previous shot needs a clip or still first'}>
                <SkipForward size={14} /> From previous shot
              </button>
            )}
            {!start && scene.endImageId && (
              <button type="button" onClick={() => { onEditLocal(scene.sceneId, { endImageId: null }); onSave(scene.sceneId, { endImageId: null }); }}
                className={SECONDARY_BUTTON}
                aria-label={`Clear scene ${index + 1} end frame`} title="The clip ends where the model takes it; the end frame's takes stay">
                <X size={14} /> No end frame
              </button>
            )}
          </div>
        )}
        {start && onContinueFromPrevious && scene.referenceImageId && (
          <label htmlFor={id('keep-still-end')} className="flex items-center gap-1 text-[11px] text-port-text-muted min-h-[44px] pointer-fine:sm:min-h-0">
            <input id={id('keep-still-end')} type="checkbox" checked={keepStillAsEnd} onChange={(e) => setKeepStillAsEnd(e.target.checked)} />
            From previous shot: keep this frame as the end frame
          </label>
        )}
        <SceneTakeStrip project={project} scene={scene} kind={start ? 'image' : 'endImage'} busy={takeBusy} saving={pendingTakes} grid
          onRefine={(take) => openRefine(which, take.assetId)} refineDisabled={sharedTake || !!generating}
          onSelect={(take) => onSelectTake?.(scene, take)}
          onReview={(take, review) => onReviewTake?.(scene, take, review)}
          onOpenPreview={onOpenPreview} marks={assetMarks} onMark={onMarkTake}
          onCheck={onCheckTake ? (take) => onCheckTake(scene, take) : null} checking={checkingTakes}
          onMove={onMoveTake ? (take, toSceneId) => onMoveTake(scene, take, toSceneId) : null} />
      </div>
    );
  };

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
          {column('start')}
          <ArrowRight size={14} aria-hidden="true" className="hidden self-start text-port-text-muted @sm:mt-12 @sm:block" />
          {column('end')}
        </div>
      ) : column('start')}
      {endFrames && onSwapFrames && frames.start && frames.end && (
        <button type="button" onClick={onSwapFrames} disabled={takeBusy} className={SECONDARY_BUTTON}
          title="The start frame becomes the end frame and the end frame the start, each with its prompt">
          <ArrowLeftRight size={14} /> Swap start and end
        </button>
      )}
    </section>
  );
}
