import { castLookForTake } from '../../../../server/lib/musicVideoCastLook.js';
import { musicVideoGreyboxReference } from '../../../../server/lib/musicVideoGreybox.js';
import SceneFramePromptPreview from './SceneFramePromptPreview.jsx';
import SceneFrameReferenceLimitNotice from './SceneFrameReferenceLimitNotice.jsx';
import SceneGreyboxReference from './SceneGreyboxReference.jsx';
import { useState } from 'react';
import { Activity, ArrowLeftRight, ArrowRight, Image as ImageIcon, ImagePlus, PencilLine, Shuffle, SkipForward, Wand2, X } from 'lucide-react';
import AutoSizeTextarea from '../ui/AutoSizeTextarea.jsx';
import InfoTooltip from '../ui/InfoTooltip';
import SceneTakeStrip from './SceneTakeStrip.jsx';
import SceneCameoLink from './SceneCameoLink.jsx';
import SceneFrameReferences from './SceneFrameReferences.jsx';
import SceneResearchSeed from './SceneResearchSeed.jsx';
import { shotSheetDrivesPrompt } from '../../../../server/lib/musicVideoShotSheet.js';

const PRIMARY_BUTTON = 'flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] pointer-fine:sm:min-h-0 whitespace-nowrap';
const SECONDARY_BUTTON = 'flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] pointer-fine:sm:min-h-0 whitespace-nowrap';
const SELECT = 'min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50';

/** One of a shot's two frames: tap it to see it full size. */
function FrameTile({ label, imageId, empty, onOpen, openLabel }) {
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
      <img src={`/data/images/${encodeURIComponent(imageId)}`} alt="" className="block aspect-video w-full bg-black object-cover" />
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
      <AutoSizeTextarea id={id} value={value} rows={3} {...props}
        className="block w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm" />
    </>
  );
}

const REFERENCE_LABELS = { '': 'Prompt only', start: 'Start frame', end: 'End frame' };
// Both render from the current prompt and Casting look; only Re-render replaces the selected frame (takes.js `replaceSelection`).
const NEW_TAKE_HINT = 'Renders another candidate and adds it to the takes below. The frame in use stays selected until you pick a new take.';
const RERENDER_HINT = 'Renders this frame again from the current Casting look and swaps it in as the selected frame. The old frame stays in the takes.';

/**
 * A shot's frames: the still its clip starts from and, for footage, the
 * optional one it ends on (#11173). Each frame shows its prompt and its own
 * Render right under the picture, and can render from the start or end frame
 * as an image reference (`onGenerateFrame` / `onGenerateEndFrame` take
 * `{ referenceImageId }`, null for prompt only). Refine edits a frame by a
 * short instruction (`{ referenceImageId, refine }`), and Swap puts one of the
 * video's unused stills on it. Each frame's own takes sit under it as a grid,
 * so both frames' actions and takes show at once; tapping a frame opens it full size.
 * With both frames set, `onSwapFrames` trades them (prompts included) in one tap.
 * The References row above them picks the character and set references every frame render sends;
 * Research and seed above it imports real photos of the shot's subject that lead those references.
 * With `endFrameToggle` (footage), Use end frame switches the end frame off (`scene.endFrameOff`):
 * its column hides and clips skip it, keeping its selection, prompt and takes for switching back on.
 */
export default function SceneFrames({
  project = null, castMedia = null, onReloadCastMedia = null, greyboxPlaces = {}, greyboxSaving = false, onGreyboxSaving, scene, index, endFrames: endFramesAllowed, endFrameToggle = false, generatingFrame = false, generatingEndFrame = false, onGenerateFrame, onGenerateEndFrame,
  onEditLocal, onSave, onOpenPreview, takeBusy = false, onSelectTake, onReviewTake, onSwap = null, onImportTake = null,
  onContinueFromPrevious = null, previousHasClip = false, onSwapFrames = null, assetMarks = null, onMarkTake = null, onCheckTake = null, checkingTakes = null, onApplyCameos = null,
}) {
  const endFrameOff = endFrameToggle && scene.endFrameOff === true;
  const endFrames = endFramesAllowed && !endFrameOff;
  // A detail-built shot: its frame prompt is the still's general prompt and the shot details are composed in.
  const fromSheet = shotSheetDrivesPrompt(scene);
  const setEndFrameOn = (on) => { const patch = { endFrameOff: on ? null : true }; onEditLocal(scene.sceneId, patch); onSave(scene.sceneId, patch); };
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
  const frames = { start: scene.referenceImageId || null, end: endFrames ? scene.endImageId || null : null };
  const refOf = (which) => (frames[refs[which]] ? refs[which] : '');
  const id = (name) => `mv-scene-${scene.sceneId}-${name}`;

  const column = (which) => {
    const start = which === 'start';
    const label = start ? (endFrames ? 'Start' : 'Still') : 'End';
    const field = start ? 'framePrompt' : 'endFramePrompt';
    const generating = start ? generatingFrame : generatingEndFrame;
    const imageId = frames[which];
    const ref = refOf(which);
    const refChoices = ['', ...['start', 'end'].filter((key) => frames[key])];
    const needsPrompt = !start && !scene.endFramePrompt?.trim();
    const render = () => (start ? onGenerateFrame : onGenerateEndFrame)?.(scene, { referenceImageId: ref ? frames[ref] : null });
    const kind = start ? 'image' : 'endImage';
    const selected = imageId ? (scene.takes || []).find((take) => take?.kind === kind && take.assetId === imageId) : null;
    const olderLook = selected ? castLookForTake(project, scene, selected, castMedia).status === 'older' : false;
    const rerender = () => {
      if (greyboxBlocked || generating || needsPrompt) return;
      (start ? onGenerateFrame : onGenerateEndFrame)?.(scene, { referenceImageId: ref ? frames[ref] : null, replaceSelection: true });
    };
    const refineLocked = greyboxBlocked || !!generating;
    const refine = (e) => {
      e.preventDefault();
      if (!instruction.trim() || refineLocked) return;
      (start ? onGenerateFrame : onGenerateEndFrame)?.(scene, { referenceImageId: imageId, refine: instruction.trim() });
      setRefining(null);
      setInstruction('');
    };
    return (
      <div key={which} className="min-w-0 space-y-1.5">
        <FrameTile label={label} imageId={imageId} empty={start ? 'No still yet' : 'Optional'} onOpen={() => onOpenPreview?.(`image:${imageId}`)}
          openLabel={`View scene ${index + 1} ${start ? 'reference' : 'end'} frame full size`} />
        <FramePrompt id={id(`${which}-prompt`)} label={start ? (fromSheet ? 'General frame prompt' : endFrames ? 'Start frame prompt' : 'Frame prompt') : 'End frame prompt'} value={scene[field] || ''}
          help={start && fromSheet ? GENERAL_PROMPT_HELP : FRAME_PROMPT_HELP}
          onChange={(e) => onEditLocal(scene.sceneId, { [field]: e.target.value })}
          onBlur={(e) => onSave(scene.sceneId, { [field]: e.target.value || null })}
          placeholder={start ? (fromSheet ? 'Anything the shot details don\'t cover' : 'What the frame shows (empty: uses the clip prompt)') : 'Where the shot ends, e.g. her head thrown back, eyes white'} />
        {/* What the frame sends: its prompt plus every addition, as chips. */}
        {project && <SceneFramePromptPreview project={project} scene={scene} castMedia={castMedia} greybox={greybox} slot={which} referenceImageId={ref ? frames[ref] : null} />}
        {project && <SceneFrameReferenceLimitNotice project={project} scene={scene} castMedia={castMedia} greybox={greybox} sourceImageId={ref ? frames[ref] : null} />}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={render} disabled={greyboxBlocked || !!generating || needsPrompt} className={PRIMARY_BUTTON}
            title={needsPrompt ? 'Describe the end frame first' : imageId ? NEW_TAKE_HINT : ref ? `Render from the ${REFERENCE_LABELS[ref].toLowerCase()} with this prompt` : 'Render from this prompt'}>
            {generating ? <Activity size={14} className="animate-spin" /> : start ? <ImageIcon size={14} /> : <Wand2 size={14} />}
            {generating ? 'Generating…' : start ? (imageId ? 'New frame take' : 'Generate frame') : (imageId ? 'New end frame take' : 'Generate end frame')}
          </button>
          {olderLook && (
            <button type="button" onClick={rerender} disabled={greyboxBlocked || !!generating || needsPrompt} className={SECONDARY_BUTTON}
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
            <button type="button" onClick={() => { setRefining(refining === which ? null : which); setInstruction(''); }} disabled={refineLocked}
              aria-expanded={refining === which} className={SECONDARY_BUTTON} title="Edit this frame with a short instruction, keeping the rest">
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
        {olderLook && (
          <p className="text-xs text-port-text-muted">Older look: Casting changed since this was rendered. Re-render to use the new look.</p>
        )}
        {refining === which && imageId && (<>
          <form onSubmit={refine} className="flex min-w-0 gap-2">
            <label htmlFor={id(`${which}-refine`)} className="sr-only">{`What to change in the ${start ? 'start' : 'end'} frame`}</label>
            <input id={id(`${which}-refine`)} type="text" value={instruction} onChange={(e) => setInstruction(e.target.value)}
              placeholder="What to change, e.g. remove the hand"
              className="min-w-0 flex-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-base sm:text-sm" />
            {greybox?.reference && <SceneFramePromptPreview project={project} scene={scene} castMedia={castMedia} greybox={greybox} slot={which} referenceImageId={imageId} instruction={instruction} />}
            <button type="submit" disabled={!instruction.trim() || refineLocked} className={PRIMARY_BUTTON}
              aria-label={`Render refined ${start ? 'start' : 'end'} frame`}>
              <Wand2 size={14} /> Render
            </button>
          </form>
          {project && <SceneFrameReferenceLimitNotice project={project} scene={scene} castMedia={castMedia} greybox={greybox} sourceImageId={imageId} />}
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
        <SceneTakeStrip scene={scene} kind={start ? 'image' : 'endImage'} busy={takeBusy} grid
          onSelect={(take) => onSelectTake?.(scene, take)}
          onReview={(take, review) => onReviewTake?.(scene, take, review)}
          onOpenPreview={onOpenPreview} marks={assetMarks} onMark={onMarkTake}
          onCheck={start && onCheckTake ? (take) => onCheckTake(scene, take) : null} checking={checkingTakes} />
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
