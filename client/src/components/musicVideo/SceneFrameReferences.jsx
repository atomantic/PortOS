import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { musicVideoConditioningReferences, musicVideoReferenceChoices, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES } from '../../../../server/lib/musicVideoConditioning.js';
import { MUSIC_VIDEO_OTHER_REFERENCES_NOTE } from '../../../../server/lib/musicVideoShotPrompt.js';

const CHIP = 'inline-flex min-h-[44px] max-w-full items-center gap-1 rounded border border-port-border bg-port-bg p-0.5 text-xs sm:min-h-[32px]';
const thumb = (ref) => <img src={`/data/images/${encodeURIComponent(ref.imageId)}`} alt="" className="h-8 w-8 shrink-0 rounded bg-black object-cover" />;
const nameOf = (ref) => ref.label || ref.role || 'Reference';

/**
 * The character and set references sent with this shot's frame renders (start,
 * end and both refines), shown as chips. Until the director changes them it is
 * the automatic set (the main character, the section's set and anyone the
 * prompt names); a change is kept on the shot (`frameReferenceIds`), and Auto
 * puts the automatic set back.
 */
export default function SceneFrameReferences({ project, scene, onEditLocal, onSave, disabled = false }) {
  const [adding, setAdding] = useState(false);
  const choices = musicVideoReferenceChoices(project);
  if (!choices.length) return null;
  const chosen = musicVideoConditioningReferences(project, scene);
  const ids = chosen.map((ref) => ref.id);
  const others = choices.filter((ref) => !ids.includes(ref.id));
  const auto = !Array.isArray(scene.frameReferenceIds);
  const full = ids.length >= MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES;
  const set = (next) => { onEditLocal(scene.sceneId, { frameReferenceIds: next }); onSave(scene.sceneId, { frameReferenceIds: next }); };

  return (
    <div role="group" aria-label="References sent with the frames" className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-port-text-muted">
        <span className="font-medium text-port-text">References</span>
        {auto ? <span>Auto: from the prompt</span> : (
          <button type="button" onClick={() => set(null)} disabled={disabled} className="min-h-[44px] underline sm:min-h-0">Back to auto</button>
        )}
      </div>
      <ul className="flex flex-wrap gap-1">
        {chosen.map((ref) => (
          <li key={ref.id} className={CHIP}>
            {thumb(ref)}
            <span className="min-w-0 max-w-[10rem] truncate">{nameOf(ref)}</span>
            <button type="button" onClick={() => set(ids.filter((id) => id !== ref.id))} disabled={disabled} aria-label={`Don't send ${nameOf(ref)}`}
              className="inline-flex min-h-[40px] min-w-[32px] items-center justify-center rounded hover:bg-port-border disabled:opacity-50 sm:min-h-[28px] sm:min-w-[24px]">
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        ))}
        {others.length > 0 && (
          <li>
            <button type="button" onClick={() => setAdding((open) => !open)} disabled={disabled || full} aria-expanded={adding}
              title={full ? `Up to ${MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES} references` : 'Send another character or set'}
              className={`${CHIP} px-2 disabled:opacity-50`}>
              <Plus size={12} aria-hidden="true" /> Add
            </button>
          </li>
        )}
      </ul>
      {chosen.length === 0 && <p className="text-[11px] text-port-text-muted">No references: frames render from the prompt alone.</p>}
      {adding && !full && (
        <ul aria-label="References to add" className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
          {others.map((ref) => (
            <li key={ref.id} className="min-w-0">
              <button type="button" onClick={() => { set([...ids, ref.id]); setAdding(false); }} disabled={disabled}
                className={`${CHIP} w-full text-left hover:bg-port-border/40`}>
                {thumb(ref)}<span className="min-w-0 truncate">{nameOf(ref)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {chosen.length > 0 && (
        <details className="text-[11px] text-port-text-muted">
          <summary className="cursor-pointer">Note sent with refines and end frames</summary>
          <p className="mt-1">{MUSIC_VIDEO_OTHER_REFERENCES_NOTE}</p>
        </details>
      )}
    </div>
  );
}
