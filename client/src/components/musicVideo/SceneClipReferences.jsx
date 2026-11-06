import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  MUSIC_VIDEO_MAX_REFERENCE_CHOICES, musicVideoClipConditioningReferences, musicVideoClipReferenceCapacity, musicVideoClipReferenceChoices, musicVideoOfferedReferences, musicVideoSceneCastIds,
} from '../../../../server/lib/musicVideoConditioning.js';
import MediaImage from '../MediaImage';
import SceneReferencePicker from './SceneReferencePicker.jsx';
import { formatCount } from '../../utils/formatters.js';
import { localModelTakesSongAudio } from '../../../../server/lib/musicVideoLocalModels.js';
import { isPerformanceScene } from '../../../../server/lib/musicVideoShotTiming.js';

const BUTTON = 'inline-flex min-h-[44px] max-w-full items-center gap-1 rounded border border-port-border bg-port-bg px-2 text-xs hover:bg-port-border/40 disabled:opacity-50 sm:min-h-[32px]';
const nameOf = (ref) => ref.label || ref.role || 'Reference';

/** The extra images this model will receive alongside the shot's frame. */
export default function SceneClipReferences({ project, scene, castMedia, backend, model, capacityOverride, endFrameBlocksReferences = false, ltxReferencesOff = false, onEditLocal, onSave, onSaveState, saveState }) {
  const [adding, setAdding] = useState(false);
  const allChoices = musicVideoClipReferenceChoices(project, scene, castMedia);
  const choices = musicVideoOfferedReferences(allChoices).filter((ref) => ref.imageId !== scene.referenceImageId);
  const chosen = musicVideoClipConditioningReferences(project, scene, castMedia);
  const chosenIds = chosen.map((ref) => ref.id);
  const unresolved = (scene.clipReferenceIds || []).filter((id) => !allChoices.some((ref) => ref.id === id));
  const retained = (scene.clipReferenceIds || []).filter((id) => !chosenIds.includes(id));
  const others = choices.filter((ref) => !chosenIds.includes(ref.id));
  const auto = !Array.isArray(scene.clipReferenceIds);
  const capacity = capacityOverride ?? musicVideoClipReferenceCapacity(backend, model);
  const unknownModel = !backend || (['local', 'fal', 'runway'].includes(backend) && !model);
  const locked = saveState === 'saving' || Boolean(castMedia && musicVideoSceneCastIds(project, scene).some((id) => castMedia[id] === undefined));
  // Most Runway models pin the start frame unless references go with it: their keyframe and reference modes cannot mix.
  const runwayUnpinsStart = backend === 'runway' && capacity > 0 && !!model?.referenceImages && !model.referenceImages.keepsFrames;
  const looseStart = (backend === 'fal' && model?.referenceImages && !model.image)
    || (runwayUnpinsStart && chosen.length > 0)
    || (backend === 'local' && model?.fastvideoFamily === 'fasth3omni');
  // The server renders these without the song window (submitJob.js) rather than refusing.
  const songUnheard = backend === 'local' && model && !localModelTakesSongAudio(model)
    && project?.videoSettings?.generationMode === 'suppliedAudio' && !isPerformanceScene(scene);
  const capacityNote = backend === 'remote' ? 'Peer render pools cannot receive extra clip references.'
    : unknownModel ? 'Select a model to see its reference support.'
      : endFrameBlocksReferences ? 'Runway cannot combine an end frame with image references, so these are not sent while the end frame is on.'
        : capacity ? `PortOS can send up to ${formatCount(capacity)} additional image ${capacity === 1 ? 'reference' : 'references'} with this model.`
          : ltxReferencesOff ? 'Turn on Use LTX reference images to send them.'
            : 'This model does not use additional image references.';
  // Listed references that stay behind must be hard to miss: the clip renders without them.
  const notSent = chosen.length > 0 && !capacity && !unknownModel;
  const save = (next) => {
    onEditLocal(scene.sceneId, { clipReferenceIds: next });
    onSaveState('saving');
    Promise.resolve(onSave(scene.sceneId, { clipReferenceIds: next }))
      .then((saved) => onSaveState(saved === false ? 'failed' : 'saved'), () => onSaveState('failed'));
  };
  const update = (ids) => save(ids && [...ids, ...retained].slice(0, MUSIC_VIDEO_MAX_REFERENCE_CHOICES));

  return (
    <div role="group" aria-label="Clip references" className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-port-text-muted">
        <span className="font-medium text-port-text">Clip references</span>
        {auto ? <span>Auto: cast from Frames</span> : <button type="button" className="min-h-[44px] underline sm:min-h-0" disabled={locked} onClick={() => save(null)}>Back to auto</button>}
      </div>
      <p className="text-[11px] text-port-text-muted">
        {scene.referenceImageId
          ? looseStart ? 'The selected start frame is a guide; this model does not pin the opening frame.' : 'The selected start frame is sent with the clip.'
          : 'Select a start frame before rendering.'}
        {!notSent && ` ${capacityNote}`}
        {songUnheard && ' This model does not hear the song, so the clip renders without song audio.'}
      </p>
      {notSent && (
        <p role="status" className="rounded border border-port-warning/40 bg-port-warning/10 px-2 py-1 text-xs text-port-warning">
          These references are not sent with this clip. {capacityNote}
        </p>
      )}
      {backend === 'fal' && capacity > 0 && <p className="text-[11px] text-port-text-muted">Reference inputs may add to the provider charge.</p>}
      {runwayUnpinsStart && <p className="text-[11px] text-port-text-muted">Remove every reference to pin the opening frame.</p>}
      <ul className="flex flex-wrap gap-1">
        {chosen.map((ref, index) => (
          <li key={ref.id} className={`${BUTTON} pr-0.5`}>
            <MediaImage thumbnail src={`/data/images/${encodeURIComponent(ref.imageId)}`} fallbackSrc={`/data/image-refs/${encodeURIComponent(ref.imageId)}`} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
            <span className="max-w-[10rem] truncate">{nameOf(ref)}{index >= capacity ? ' · not sent' : ''}</span>
            <button type="button" aria-label={`Remove clip reference ${nameOf(ref)}`} disabled={locked}
              onClick={() => update(chosenIds.filter((id) => id !== ref.id))}
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex min-h-[40px] min-w-[32px] items-center justify-center rounded hover:bg-port-border sm:min-h-[28px] sm:min-w-[24px]">
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        ))}
        {others.length > 0 && capacity > chosen.length && (
          <li><button type="button" className={BUTTON} disabled={locked} aria-expanded={adding} onClick={() => setAdding((open) => !open)}><Plus size={12} aria-hidden="true" /> Add</button></li>
        )}
      </ul>
      {capacity > 0 && !locked && unresolved.length > 0 && <p className="text-[11px] text-port-warning">Some saved references are unavailable. Restore them or return to auto before rendering.</p>}
      {saveState === 'failed' && <button type="button" className={BUTTON} onClick={() => save(scene.clipReferenceIds ?? null)}>Retry saving clip references</button>}
      <SceneReferencePicker open={adding && capacity > chosen.length} references={others} label="Clip references to add"
        hint={`This model takes ${formatCount(Math.max(0, capacity - chosen.length))} more.`} onClose={() => setAdding(false)}
        tileProps={(ref) => ({ disabled: locked, onClick: () => { update([...chosenIds, ref.id]); setAdding(false); } })} />
    </div>
  );
}
