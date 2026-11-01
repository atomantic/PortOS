import { castLookForTake } from '../../../../server/lib/musicVideoCastLook.js';
import { musicVideoGreyboxReference } from '../../../../server/lib/musicVideoGreybox.js';
import SceneFramePromptPreview from './SceneFramePromptPreview.jsx';
import SceneGreyboxReference from './SceneGreyboxReference.jsx';
import { useLayoutEffect, useRef, useState } from 'react';
import { Activity, ArrowLeftRight, ArrowRight, Image as ImageIcon, ImagePlus, PencilLine, Shuffle, SkipForward, Wand2, X } from 'lucide-react';
import SceneTakeStrip from './SceneTakeStrip.jsx';
import SceneCastVariant from './SceneCastVariant.jsx';
import SceneFrameReferences from './SceneFrameReferences.jsx';

const PRIMARY_BUTTON = 'flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';
const SECONDARY_BUTTON = 'flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';
const SELECT = 'min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50';

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

/**
 * A frame prompt that grows to fit its text, so a long prompt never sits
 * scrolled partway inside a short box (on iOS that left a half-cut line).
 */
function FramePrompt({ id, label, value, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value]);
  return (
    <>
      <label htmlFor={id} className="sr-only">{label}</label>
      <textarea ref={ref} id={id} value={value} rows={3} {...props}
        className="block max-h-80 w-full resize-none overflow-y-auto bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm" />
    </>
  );
}

const REFERENCE_LABELS = { '': 'Prompt only', start: 'Start frame', end: 'End frame' };

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
 * The References row above them picks the character and set references every frame render sends.
 */
export default function SceneFrames({
  project = null, castMedia = null, greyboxPlaces = {}, greyboxSaving = false, onGreyboxSaving, scene, index, endFrames, generatingFrame = false, generatingEndFrame = false, onGenerateFrame, onGenerateEndFrame,
  onEditLocal, onSave, onOpenPreview, takeBusy = false, onSelectTake, onReviewTake, onSwap = null, onImportTake = null,
  onContinueFromPrevious = null, previousHasClip = false, onSwapFrames = null, assetMarks = null, onMarkTake = null,
}) {
  const greybox = musicVideoGreyboxReference(project, scene, greyboxPlaces);
  const [referenceSaving, setReferenceSaving] = useState(false);
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
        <FramePrompt id={id(`${which}-prompt`)} label={start ? 'Reference frame prompt' : 'End frame prompt'} value={scene[field] || ''}
          onChange={(e) => onEditLocal(scene.sceneId, { [field]: e.target.value })}
          onBlur={(e) => onSave(scene.sceneId, { [field]: e.target.value || null })}
          placeholder={start ? 'Start frame prompt (defaults to the shot prompt)' : 'Where the shot ends, e.g. her head thrown back, eyes white'} />
        {/* A greybox or a storyboard panel adds to the still's prompt, so its full input shows here. */}
        {(greybox?.reference || scene.panelId) && <SceneFramePromptPreview project={project} scene={scene} castMedia={castMedia} greybox={greybox} slot={which} referenceImageId={ref ? frames[ref] : null} />}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={render} disabled={greyboxBlocked || !!generating || needsPrompt} className={PRIMARY_BUTTON}
            title={needsPrompt ? 'Describe the end frame first' : ref ? `Render from the ${REFERENCE_LABELS[ref].toLowerCase()} with this prompt` : 'Render from this prompt'}>
            {generating ? <Activity size={14} className="animate-spin" /> : start ? <ImageIcon size={14} /> : <Wand2 size={14} />}
            {generating ? 'Generating…' : start ? (imageId ? 'New frame take' : 'Generate frame') : (imageId ? 'New end frame take' : 'Generate end frame')}
          </button>
          {olderLook && (
            <button type="button" onClick={rerender} disabled={greyboxBlocked || !!generating || needsPrompt} className={SECONDARY_BUTTON}
              aria-label={`Re-render ${start ? 'start' : 'end'} frame`}
              title="Render this frame again from the current Casting look and use it">
              Re-render
            </button>
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
        {refining === which && imageId && (
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
        )}
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
          <label htmlFor={id('keep-still-end')} className="flex items-center gap-1 text-[11px] text-port-text-muted min-h-[44px] sm:min-h-0">
            <input id={id('keep-still-end')} type="checkbox" checked={keepStillAsEnd} onChange={(e) => setKeepStillAsEnd(e.target.checked)} />
            From previous shot: keep this frame as the end frame
          </label>
        )}
        <SceneTakeStrip scene={scene} kind={start ? 'image' : 'endImage'} busy={takeBusy} grid
          onSelect={(take) => onSelectTake?.(scene, take)}
          onReview={(take, review) => onReviewTake?.(scene, take, review)}
          onOpenPreview={onOpenPreview} marks={assetMarks} onMark={onMarkTake} />
      </div>
    );
  };

  return (
    <section aria-label="Still" className="@container min-w-0 space-y-2">
      <h4 className="text-xs font-medium">{endFrames ? 'Frames' : 'Still'}</h4>
      <SceneGreyboxReference project={project} scene={scene} places={greyboxPlaces} onSaving={(saving) => { setReferenceSaving(saving); onGreyboxSaving?.(saving); }}
        onChange={async (setReference) => { const saved = await onSave(scene.sceneId, { setReference }); if (saved !== false) onEditLocal(scene.sceneId, { setReference }); return saved; }} />
      <SceneCastVariant project={project} scene={scene} castMedia={castMedia} onEditLocal={onEditLocal} onSave={onSave} />
      <SceneFrameReferences project={project} scene={scene} castMedia={castMedia} greybox={greybox} onEditLocal={onEditLocal} onSave={onSave} />
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
