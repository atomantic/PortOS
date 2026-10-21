import { CAST_ERAS } from '../../../../server/lib/catalogMediaLibrary.js';

const FIELD = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 text-xs sm:min-h-[32px]';

/**
 * Which Casting cast member this shot features, and at what age, era or look
 * (#12763). Saved as `scene.characterVariant`; the shot's frames then lead with
 * that member's render guides closest to the variant (References row below).
 * Only subjects saved to Casting (`ingredientId`) can be picked.
 */
export default function SceneCastVariant({ project, scene, castMedia = null, onEditLocal, onSave, disabled = false }) {
  const cast = (project?.concept?.subjects || []).filter((s) => s?.kind === 'character' && s.ingredientId);
  if (!cast.length) return null;
  const variant = scene.characterVariant || null;
  const id = (name) => `mv-scene-${scene.sceneId}-cast-${name}`;
  // A shot's hand-picked references keep their guide ids only for the variant that picked them.
  // A pick of only guides returns to Auto (null), so the new variant's guides lead; [] would send nothing.
  const save = (next) => {
    const picked = scene.frameReferenceIds;
    const kept = Array.isArray(picked) ? picked.filter((refId) => !refId.startsWith('mvr-guide-')) : null;
    const patch = Array.isArray(picked)
      ? { characterVariant: next, frameReferenceIds: kept.length || !picked.length ? kept : null }
      : { characterVariant: next };
    onEditLocal(scene.sceneId, patch);
    onSave(scene.sceneId, patch);
  };
  const withField = (key, value) => {
    const next = { ...variant, [key]: value };
    if (value === undefined) delete next[key];
    return next;
  };
  const looks = variant
    ? [...new Set((castMedia?.[variant.ingredientId] || []).map((m) => m.library?.variant?.wardrobeId).filter(Boolean))]
    : [];
  if (variant?.wardrobeId && !looks.includes(variant.wardrobeId)) looks.push(variant.wardrobeId);

  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-wrap items-end gap-2">
      <legend className="sr-only">Cast member in this shot</legend>
      <div className="flex min-w-0 flex-col">
        <label htmlFor={id('member')} className="text-[11px] text-port-text-muted">Cast guides</label>
        <select id={id('member')} className={`${FIELD} max-w-full`} value={variant?.ingredientId || ''}
          onChange={(e) => save(e.target.value ? { ingredientId: e.target.value } : null)}>
          <option value="">None</option>
          {cast.map((s) => <option key={s.ingredientId} value={s.ingredientId}>{s.name}</option>)}
          {variant && !cast.some((s) => s.ingredientId === variant.ingredientId) && <option value={variant.ingredientId}>Removed cast member</option>}
        </select>
      </div>
      {variant && (
        <>
          <div className="flex flex-col">
            <label htmlFor={id('age')} className="text-[11px] text-port-text-muted">Age</label>
            {/* Keyed on the saved age so an edit elsewhere (another tab, a synced machine) shows here. */}
            <input key={variant.age ?? ''} id={id('age')} type="number" min={0} max={150} step={1} inputMode="numeric" defaultValue={variant.age ?? ''}
              className={`${FIELD} w-20`}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                const age = raw === '' ? undefined : Number(raw);
                if (age !== undefined && (!Number.isInteger(age) || age < 0 || age > 150)) { e.target.value = variant.age ?? ''; return; }
                if (age !== variant.age) save(withField('age', age));
              }} />
          </div>
          <div className="flex flex-col">
            <label htmlFor={id('era')} className="text-[11px] text-port-text-muted">Era</label>
            <select id={id('era')} className={FIELD} value={variant.era || ''} onChange={(e) => save(withField('era', e.target.value || undefined))}>
              <option value="">Any</option>
              {CAST_ERAS.map((era) => <option key={era} value={era}>{era}</option>)}
            </select>
          </div>
          {looks.length > 0 && (
            <div className="flex min-w-0 flex-col">
              <label htmlFor={id('look')} className="text-[11px] text-port-text-muted">Look</label>
              <select id={id('look')} className={`${FIELD} max-w-full`} value={variant.wardrobeId || ''} onChange={(e) => save(withField('wardrobeId', e.target.value || undefined))}>
                <option value="">Any</option>
                {looks.map((look) => <option key={look} value={look}>{look}</option>)}
              </select>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}
