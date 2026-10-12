import { useState } from 'react';
import { Activity, ArrowRight, Image as ImageIcon, ImagePlus, Maximize2, Shuffle, SkipForward, Wand2, X } from 'lucide-react';
import SceneTakeStrip from './SceneTakeStrip.jsx';

const PRIMARY_BUTTON = 'flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';
const SECONDARY_BUTTON = 'flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';
const SELECT = 'min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50';

/** One of a shot's two frames: tap to work on its takes, the corner button to see it full size. */
function FrameTile({ label, imageId, empty, active, onPick, onOpen, openLabel }) {
  return (
    <div className="relative min-w-0">
      <button type="button" onClick={onPick} aria-pressed={active} aria-label={`${label} frame${imageId ? '' : `: ${empty}`}`}
        className={`block w-full overflow-hidden rounded border ${active ? 'border-port-accent ring-2 ring-port-accent' : 'border-port-border'} focus:outline-none focus:ring-2 focus:ring-port-accent`}>
        {imageId
          ? <img src={`/data/images/${encodeURIComponent(imageId)}`} alt="" className="block aspect-video w-full bg-black object-cover" />
          : <span className="flex aspect-video w-full items-center justify-center text-[11px] text-port-text-muted">{empty}</span>}
        <span className="port-media-overlay-strong absolute left-1 top-1 rounded px-1 text-[10px] leading-tight">{label}</span>
      </button>
      {imageId && (
        <button type="button" onClick={onOpen} aria-label={openLabel} title={openLabel}
          className="port-media-overlay-strong absolute right-1 top-1 flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-1 sm:min-h-0 sm:min-w-0">
          <Maximize2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

const REFERENCE_LABELS = { '': 'Prompt only', start: 'Start frame', end: 'End frame' };

/**
 * A shot's frames: the still its clip starts from and, for footage, the
 * optional one it ends on (#11173). Each frame shows its prompt and its own
 * Render right under the picture, and can render from the start or end frame
 * as an image reference (`onGenerateFrame` / `onGenerateEndFrame` take
 * `{ referenceImageId }`, null for prompt only). Tapping a frame picks whose
 * takes show below, as a grid, with that frame's swap and import actions.
 */
export default function SceneFrames({
  scene, index, endFrames, generatingFrame = false, generatingEndFrame = false, onGenerateFrame, onGenerateEndFrame,
  onEditLocal, onSave, onOpenPreview, takeBusy = false, onSelectTake, onReviewTake, onSwap = null, onImportTake = null,
  onContinueFromPrevious = null, previousHasClip = false, clipLocked = false,
}) {
  const [side, setSide] = useState('start');
  const [keepStillAsEnd, setKeepStillAsEnd] = useState(false);
  // Which frame each render starts from: the start frame renders from its prompt, the end frame from the start frame.
  const [refs, setRefs] = useState({ start: '', end: 'start' });
  const frames = { start: scene.referenceImageId || null, end: endFrames ? scene.endImageId || null : null };
  const refOf = (which) => (frames[refs[which]] ? refs[which] : '');
  const lockedTitle = 'Video locked. Unlock the video to change it.';
  const id = (name) => `mv-scene-${scene.sceneId}-${name}`;
  const activeSide = endFrames ? side : 'start';

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
    return (
      <div key={which} className="min-w-0 space-y-1.5">
        <FrameTile label={label} imageId={imageId} empty={start ? 'No still yet' : 'Optional'} active={endFrames && activeSide === which}
          onPick={() => setSide(which)} onOpen={() => onOpenPreview?.(`image:${imageId}`)}
          openLabel={`View scene ${index + 1} ${start ? 'reference' : 'end'} frame full size`} />
        <label htmlFor={id(`${which}-prompt`)} className="sr-only">{start ? 'Reference frame prompt' : 'End frame prompt'}</label>
        <textarea id={id(`${which}-prompt`)} value={scene[field] || ''} rows={3}
          onChange={(e) => onEditLocal(scene.sceneId, { [field]: e.target.value })}
          onBlur={(e) => onSave(scene.sceneId, { [field]: e.target.value || null })}
          placeholder={start ? 'Start frame prompt (defaults to the shot prompt)' : 'Where the shot ends, e.g. her head thrown back, eyes white'}
          className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={render} disabled={!!generating || needsPrompt || (!start && clipLocked)} className={PRIMARY_BUTTON}
            title={needsPrompt ? 'Describe the end frame first' : ref ? `Render from the ${REFERENCE_LABELS[ref].toLowerCase()} with this prompt` : 'Render from this prompt'}>
            {generating ? <Activity size={14} className="animate-spin" /> : start ? <ImageIcon size={14} /> : <Wand2 size={14} />}
            {generating ? 'Generating…' : start ? (imageId ? 'New frame take' : 'Generate frame') : (imageId ? 'New end frame take' : 'Generate end frame')}
          </button>
          {refChoices.length > 1 && (
            <span className="flex min-w-0 items-center gap-1">
              <label htmlFor={id(`${which}-from`)} className="text-xs text-port-text-muted">From</label>
              <select id={id(`${which}-from`)} value={ref} onChange={(e) => setRefs((prev) => ({ ...prev, [which]: e.target.value }))}
                disabled={!!generating} className={SELECT} title="Use a frame as the image reference for this render">
                {refChoices.map((key) => <option key={key} value={key}>{REFERENCE_LABELS[key]}</option>)}
              </select>
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <section aria-label="Still" className="@container min-w-0 space-y-2">
      <h4 className="text-xs font-medium">{endFrames ? 'Frames' : 'Still'}</h4>
      {endFrames ? (
        <div role="group" aria-label="Start and end frames" className="grid gap-3 @sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          {column('start')}
          <ArrowRight size={14} aria-hidden="true" className="hidden self-start text-port-text-muted @sm:mt-12 @sm:block" />
          {column('end')}
        </div>
      ) : column('start')}
      <div className="flex flex-wrap gap-2">
        {onSwap && (
          <button type="button" onClick={() => onSwap(activeSide === 'end' ? 'endImage' : 'image')} disabled={takeBusy || clipLocked} className={SECONDARY_BUTTON}
            title={clipLocked ? lockedTitle : `Pick a still made for this video that no shot uses as the ${activeSide === 'end' ? 'end' : 'start'} frame`}>
            <Shuffle size={14} /> Swap from unused
          </button>
        )}
        {activeSide === 'start' && onImportTake && (
          <button type="button" onClick={() => onImportTake(scene)} disabled={takeBusy} className={SECONDARY_BUTTON}
            title="Add a frame from the gallery or an upload (e.g. made in an external tool) as a take">
            <ImagePlus size={14} /> Import take
          </button>
        )}
        {activeSide === 'start' && onContinueFromPrevious && (
          <button type="button" onClick={() => onContinueFromPrevious(scene, { keepStillAsEnd: keepStillAsEnd && Boolean(scene.referenceImageId) })}
            disabled={takeBusy || !previousHasClip} className={SECONDARY_BUTTON}
            title={previousHasClip ? 'Start this shot from the last frame the previous shot shows in the cut' : 'The previous shot needs a clip first'}>
            <SkipForward size={14} /> From previous shot
          </button>
        )}
        {activeSide === 'end' && scene.endImageId && (
          <button type="button" onClick={() => { onEditLocal(scene.sceneId, { endImageId: null }); onSave(scene.sceneId, { endImageId: null }); }}
            disabled={clipLocked} className={SECONDARY_BUTTON}
            aria-label={`Clear scene ${index + 1} end frame`} title="The clip ends where the model takes it; the end frame's takes stay">
            <X size={14} /> No end frame
          </button>
        )}
      </div>
      {activeSide === 'start' && onContinueFromPrevious && scene.referenceImageId && (
        <label htmlFor={id('keep-still-end')} className="flex items-center gap-1 text-[11px] text-port-text-muted min-h-[44px] sm:min-h-0">
          <input id={id('keep-still-end')} type="checkbox" checked={keepStillAsEnd} onChange={(e) => setKeepStillAsEnd(e.target.checked)} />
          From previous shot: keep this frame as the end frame
        </label>
      )}
      <SceneTakeStrip scene={scene} kind={activeSide === 'end' ? 'endImage' : 'image'} busy={takeBusy} grid
        onSelect={(take) => onSelectTake?.(scene, take)}
        onReview={(take, review) => onReviewTake?.(scene, take, review)}
        onOpenPreview={onOpenPreview} />
    </section>
  );
}
