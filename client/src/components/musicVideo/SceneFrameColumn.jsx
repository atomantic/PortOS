import { Activity, Image as ImageIcon, ImagePlus, PencilLine, Shuffle, SkipForward, Wand2, X } from 'lucide-react';
import { castLookForTake } from '../../../../server/lib/musicVideo/musicVideoCastLook.js';
import BlurCommitTextarea from '../ui/BlurCommitTextarea.jsx';
import InfoTooltip from '../ui/InfoTooltip';
import SceneFramePromptPreview from './SceneFramePromptPreview.jsx';
import SceneFrameReferenceLimitNotice from './SceneFrameReferenceLimitNotice.jsx';
import SceneFrameRefineForm from './SceneFrameRefineForm.jsx';
import SceneFrameRenderTarget, { frameRenderTargetOverrides } from './SceneFrameRenderTarget.jsx';
import SceneTakeStrip from './SceneTakeStrip.jsx';
import { shotImageUrl } from './sceneImageTreatmentUrls.js';
import { framePrimaryButtonClass as PRIMARY_BUTTON, sceneButtonClass as SECONDARY_BUTTON, selectXsShrinkClass as SELECT } from './controlClasses.js';

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

function SelectedFrameTile({ project, scene, index, start, endFrames, imageId, onOpenPreview }) {
  const label = start ? (endFrames ? 'Start' : 'Still') : 'End';
  return (
    <FrameTile label={label} imageId={imageId} src={imageId ? shotImageUrl(project?.id, scene, imageId) : null}
      empty={start ? 'No still yet' : 'Optional'} onOpen={() => onOpenPreview?.(`image:${imageId}`)}
      openLabel={`View scene ${index + 1} ${start ? 'reference' : 'end'} frame full size`} />
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
// Both render from the current prompt and Casting look; only Re-render replaces the selected frame (takes.js `replaceSelection`).
const NEW_TAKE_HINT = 'Renders another candidate and adds it to the takes below. The frame in use stays selected until you pick a new take.';
const RERENDER_HINT = 'Renders this frame again from the current Casting look and swaps it in as the selected frame. The old frame stays in the takes.';

function FrameRenderButton({ start, sourceWindow, needsPrompt, imageId, reference, blocked, generating, onRender }) {
  const frame = start ? 'frame' : 'end frame';
  let title = reference ? `Render from the ${REFERENCE_LABELS[reference].toLowerCase()} with this prompt` : 'Render from this prompt';
  if (imageId) title = NEW_TAKE_HINT;
  if (needsPrompt) title = 'Describe the end frame first';
  if (sourceWindow) title = `Plays ${sourceWindow.source?.label || 'the source shot'}'s frame`;
  return (
    <button type="button" onClick={onRender} disabled={blocked} className={PRIMARY_BUTTON} title={title}>
      {generating ? <Activity size={14} className="animate-spin" /> : start ? <ImageIcon size={14} /> : <Wand2 size={14} />}
      {generating ? 'Generating…' : imageId ? `New ${frame} take` : `Generate ${frame}`}
    </button>
  );
}

function FrameRenderActions({
  start, endFrames, which, sourceWindow, needsPrompt, imageId, reference, refChoices, setRefs, blocked, generating, render, rerender,
  olderLook, oneTake, setTakeModel, id, refineImageId, openRefine, refineBlocked, onSwap, takeBusy,
}) {
  const sharedTake = Boolean(sourceWindow);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FrameRenderButton start={start} sourceWindow={sourceWindow} needsPrompt={needsPrompt} imageId={imageId}
        reference={reference} blocked={blocked} generating={generating} onRender={render} />
      {!sharedTake && imageId && (
        <button type="button" className={SECONDARY_BUTTON} disabled={!!generating} aria-expanded={!!oneTake}
          aria-controls={id(`${which}-take-model`)} aria-label={`Image model for this ${start ? (endFrames ? 'start frame' : 'frame') : 'end frame'} take`}
          onClick={() => setTakeModel(oneTake ? null : { which, pick: '', options: {} })}>
          Image model for this take
        </button>
      )}
      {olderLook && (
        <button type="button" onClick={rerender} disabled={blocked} className={SECONDARY_BUTTON}
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
          <select id={id(`${which}-from`)} value={reference} onChange={(e) => setRefs((prev) => ({ ...prev, [which]: e.target.value }))}
            disabled={!!generating} className={SELECT} title="Use a frame as the image reference for this render">
            {refChoices.map((key) => <option key={key} value={key}>{REFERENCE_LABELS[key]}</option>)}
          </select>
        </span>
      )}
      {imageId && (
        <button type="button" onClick={() => openRefine(which, imageId)} disabled={refineBlocked}
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
  );
}

function FrameSourceActions({ start, scene, index, id, takes, onEditLocal, onSave }) {
  const { onImportTake, onContinueFromPrevious, previousHasClip, keepStillAsEnd, setKeepStillAsEnd, busy: takeBusy } = takes;
  return (
    <>
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
    </>
  );
}

function FrameColumnPrompt({ id, start, fromSheet, endFrames, scene, onEditLocal, onSave }) {
  const field = start ? 'framePrompt' : 'endFramePrompt';
  return (
    <FramePrompt id={id} label={start ? (fromSheet ? 'General frame prompt' : endFrames ? 'Start frame prompt' : 'Frame prompt') : 'End frame prompt'} value={scene[field] || ''}
      help={start && fromSheet ? GENERAL_PROMPT_HELP : FRAME_PROMPT_HELP}
      onCommit={(text) => onEditLocal(scene.sceneId, { [field]: text })}
      onBlur={(e) => onSave(scene.sceneId, { [field]: e.target.value || null })}
      placeholder={start ? (fromSheet ? 'Anything the shot details don\'t cover' : 'What the frame shows (empty: uses the clip prompt)') : 'Where the shot ends, e.g. her head thrown back, eyes white'} />
  );
}

function frameOlderLook(project, scene, assetId, kind, castMedia) {
  const selected = assetId ? (scene.takes || []).find((take) => take?.kind === kind && take.assetId === assetId) : null;
  // The server's warning (#16473) covers every character reference the record knows; Casting guides are read here.
  const olderCharacter = selected?.characterReferenceState || null;
  const olderLook = Boolean(olderCharacter) || (selected ? castLookForTake(project, scene, selected, castMedia).status === 'older' : false);
  return { olderCharacter, olderLook };
}

export default function SceneFrameColumn({
  project, scene, index, which, endFrames, fromSheet, frames, sourceWindow, id, castMedia, greybox, greyboxBlocked,
  shown, onEditLocal, onSave, onOpenPreview, rendering, generating, onGenerate, refine, takes,
}) {
  const { refs, setRefs, imageTarget, takeModel, setTakeModel, framesDefaultLabel } = rendering;
  const { refining, openRefine } = refine;
  const { busy: takeBusy, pendingTakes, onSelectTake, onReviewTake, onSwap, assetMarks, onMarkTake, onCheckTake, checkingTakes, onMoveTake } = takes;
  const start = which === 'start';
  const imageId = frames[which];
  const reference = frames[refs[which]] ? refs[which] : '';
  const referenceImageId = frames[reference] ?? null;
  const refChoices = ['', ...['start', 'end'].filter((key) => frames[key])];
  const needsPrompt = !start && !scene.endFramePrompt?.trim();
  const sharedTake = Boolean(sourceWindow);
  const blocked = sharedTake || greyboxBlocked || generating || needsPrompt;
  const refineBlocked = sharedTake || Boolean(generating) || takeBusy;
  const refineImageId = refining?.which === which ? refining.imageId : null;
  const oneTake = takeModel?.which === which ? takeModel : null;
  const renderTarget = frameRenderTargetOverrides(oneTake?.pick, oneTake?.options) || imageTarget;
  const kind = start ? 'image' : 'endImage';
  const { olderCharacter, olderLook } = frameOlderLook(project, scene, imageId, kind, castMedia);

  const render = () => {
    if (blocked) return;
    onGenerate?.(scene, { referenceImageId, ...(renderTarget ? { imageTarget: renderTarget } : {}) });
    if (oneTake) setTakeModel(null);
  };
  const rerender = () => {
    if (blocked) return;
    onGenerate?.(scene, { referenceImageId, replaceSelection: true, ...(imageTarget ? { imageTarget } : {}) });
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <SelectedFrameTile project={project} scene={scene} index={index} start={start} endFrames={endFrames} imageId={imageId} onOpenPreview={onOpenPreview} />
      <FrameColumnPrompt id={id(`${which}-prompt`)} start={start} fromSheet={fromSheet} endFrames={endFrames}
        scene={scene} onEditLocal={onEditLocal} onSave={onSave} />
      {/* What the frame sends: its prompt plus every addition, as chips. */}
      {project && <SceneFramePromptPreview project={project} scene={scene} castMedia={castMedia} greybox={greybox} slot={which} referenceImageId={referenceImageId} enabled={shown} imageTarget={renderTarget} />}
      {project && <SceneFrameReferenceLimitNotice project={project} scene={scene} castMedia={castMedia} greybox={greybox} sourceImageId={referenceImageId} />}
      <FrameRenderActions start={start} endFrames={endFrames} which={which} sourceWindow={sourceWindow} needsPrompt={needsPrompt}
        imageId={imageId} reference={reference} refChoices={refChoices} setRefs={setRefs} blocked={blocked} generating={generating} render={render} rerender={rerender}
        olderLook={olderLook} oneTake={oneTake} setTakeModel={setTakeModel} id={id} refineImageId={refineImageId} openRefine={openRefine}
        refineBlocked={refineBlocked} onSwap={onSwap} takeBusy={takeBusy} />
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
      {refineImageId && (
        <SceneFrameRefineForm project={project} scene={scene} which={which} id={id} shown={shown} castMedia={castMedia} greybox={greybox}
          sourceImageId={refineImageId} imageTarget={imageTarget} refineBlocked={refineBlocked} greyboxBlocked={greyboxBlocked} onGenerate={onGenerate} refine={refine}>
          {refineImageId !== imageId && <FrameTile label="Refining this take" imageId={refineImageId}
            onOpen={() => onOpenPreview?.(`image:${refineImageId}`)} openLabel="View refinement source full size" />}
        </SceneFrameRefineForm>
      )}
      <FrameSourceActions start={start} scene={scene} index={index} id={id} takes={takes} onEditLocal={onEditLocal} onSave={onSave} />
      <SceneTakeStrip project={project} scene={scene} kind={kind} busy={takeBusy} saving={pendingTakes} grid
        onRefine={(take) => openRefine(which, take.assetId)} refineDisabled={sharedTake || !!generating}
        onSelect={(take) => onSelectTake?.(scene, take)}
        onReview={(take, review) => onReviewTake?.(scene, take, review)}
        onOpenPreview={onOpenPreview} marks={assetMarks} onMark={onMarkTake}
        onCheck={onCheckTake ? (take) => onCheckTake(scene, take) : null} checking={checkingTakes}
        onMove={onMoveTake ? (take, toSceneId) => onMoveTake(scene, take, toSceneId) : null} />
    </div>
  );
}
