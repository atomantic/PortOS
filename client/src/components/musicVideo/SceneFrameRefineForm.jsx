import { Wand2 } from 'lucide-react';
import AutoSizeTextarea from '../ui/AutoSizeTextarea.jsx';
import SceneFramePromptPreview from './SceneFramePromptPreview.jsx';
import SceneFrameReferenceLimitNotice from './SceneFrameReferenceLimitNotice.jsx';
import { FAL_FEATURED_EDIT_MODEL_IDS, FAL_IMAGE_MODEL_OPTIONS } from '../../lib/imageGenBackends';
import { framePrimaryButtonClass as PRIMARY_BUTTON, selectXsShrinkClass as SELECT } from './controlClasses.js';

const REFINE_EDIT_MODELS = FAL_FEATURED_EDIT_MODEL_IDS
  .map((id) => FAL_IMAGE_MODEL_OPTIONS.find((row) => row.id === id))
  .filter(Boolean);

export default function SceneFrameRefineForm({
  project, scene, which, id, shown, castMedia, greybox, sourceImageId, imageTarget, refineBlocked, greyboxBlocked,
  onGenerate, refine, children,
}) {
  const { instruction, setInstruction, includeReferences, setIncludeReferences, editWith, setEditWith, refineInputRef, finish } = refine;
  const refineLocked = refineBlocked || (includeReferences && greyboxBlocked);
  // A fal Render on already leads its model list with these edit endpoints.
  const offerEditModel = (imageTarget?.mode || project?.imageMode) !== 'fal';
  const refineTarget = offerEditModel && editWith ? { mode: 'fal', cloudModel: editWith } : imageTarget;

  const submit = (e) => {
    e.preventDefault();
    if (!instruction.trim() || refineLocked) return;
    onGenerate?.(scene, {
      referenceImageId: sourceImageId,
      refine: instruction,
      ...(includeReferences ? {} : { includeReferences: false }),
      ...(refineTarget ? { imageTarget: refineTarget } : {}),
    });
    finish();
  };

  return (
    <>
      <form onSubmit={submit} className="min-w-0 space-y-2 rounded border border-port-border p-2">
        {children}
        <p className="text-xs text-port-text-muted">Creates a new take. The frame in use stays selected.</p>
        <div className="flex min-w-0 gap-2">
          <label htmlFor={id(`${which}-refine`)} className="sr-only">{`What to change in the ${which} frame`}</label>
          <AutoSizeTextarea ref={refineInputRef} id={id(`${which}-refine`)} rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)}
            placeholder="What to change, e.g. remove the hand"
            className="min-w-0 flex-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-base sm:text-sm" />
          <button type="submit" disabled={!instruction.trim() || refineLocked} className={PRIMARY_BUTTON}
            aria-label={`Render refined ${which} frame`}>
            <Wand2 size={14} /> Render
          </button>
        </div>
        <label htmlFor={id(`${which}-refine-references`)} className="flex items-center gap-2 text-xs min-h-[44px] pointer-fine:sm:min-h-0">
          <input id={id(`${which}-refine-references`)} type="checkbox" checked={includeReferences} onChange={(e) => setIncludeReferences(e.target.checked)} />
          Include shot reference images
        </label>
        <p className="text-xs text-port-text-muted">{includeReferences ? 'Sends this image plus the shot’s references, including mood-board and greybox images.' : 'Sends only the image to refine with your instruction.'}</p>
        {offerEditModel && (
          <div className="flex min-w-0 items-center gap-2">
            <label htmlFor={id(`${which}-edit-with`)} className="shrink-0 text-xs text-port-text-muted">Edit with</label>
            <select id={id(`${which}-edit-with`)} value={editWith} onChange={(e) => setEditWith(e.target.value)}
              disabled={refineLocked} className={`${SELECT} min-w-0 flex-1`} title="Featured fal.ai edit models for this refine. Current image render keeps the shot's renderer.">
              <option value="">Current image render</option>
              {REFINE_EDIT_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </div>
        )}
        {project && <SceneFramePromptPreview project={project} scene={scene} slot={which} referenceImageId={sourceImageId} instruction={instruction}
          includeReferences={includeReferences} enabled={shown} imageTarget={refineTarget} />}
      </form>
      {project && includeReferences && <SceneFrameReferenceLimitNotice project={project} scene={scene} castMedia={castMedia} greybox={greybox} sourceImageId={sourceImageId} />}
    </>
  );
}
