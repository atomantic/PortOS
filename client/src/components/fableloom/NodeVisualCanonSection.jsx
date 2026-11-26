import { FormField } from '../ui/FormField.jsx';
import { fieldClass, labelClass } from './fieldStyles';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import MediaImage from '../MediaImage';
import characterReferenceInfo from './characterReferenceInfo';

export default function NodeVisualCanonSection({
  loom, node, universe, form, setForm, patchNode, saveVisualCanon, updateVisualCanon,
  referenceCharacterId, setReferenceCharacterId, otherNodes, canonicalProtagonistId,
  scenePresence,
}) {
  return (
    <div className="rounded border border-port-border p-3 space-y-3">
      <label className="flex items-center gap-2 text-sm" htmlFor="loom-node-visual-canon">
        <input
          id="loom-node-visual-canon"
          aria-label="Bind this shot to Universe canon"
          type="checkbox"
          checked={Boolean(form.visualCanon)}
          onChange={(event) => saveVisualCanon(event.target.checked ? {
            mode: 'locked', characterAppearances: [], placeId: null, objectIds: [],
            continuitySourceNodeId: null, shotNotes: '', storyboardImageApproved: false,
          } : null)}
        />
        Bind this shot to Universe canon
      </label>
      {form.visualCanon && (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-xs" htmlFor="loom-node-canon-draft">
            <input
              id="loom-node-canon-draft"
              aria-label="Allow degraded canon draft"
              type="checkbox"
              checked={form.visualCanon.mode === 'draft'}
              onChange={(event) => updateVisualCanon({ mode: event.target.checked ? 'draft' : 'locked' })}
            />
            Allow an explicitly degraded draft when this backend cannot preserve canon
          </label>

          <fieldset className="space-y-2">
            <legend className={labelClass}>Characters</legend>
            <p className="text-[11px] text-port-text-muted">
              Bind every on-screen character to the Universe Bible. Canon-locked renders use each selected character&apos;s visual reference, wardrobe, and approved neutral/profile/full-body identity assets.
            </p>
            {canonicalProtagonistId && scenePresence !== 'offscreen'
              && !form.visualCanon.characterAppearances.some((appearance) => appearance.characterId === canonicalProtagonistId) && (
              <button
                type="button"
                aria-label="Add canonical protagonist to visual cast"
                className="text-xs text-port-accent hover:underline"
                onClick={() => updateVisualCanon({
                  characterAppearances: [
                    ...form.visualCanon.characterAppearances,
                    {
                      characterId: canonicalProtagonistId,
                      wardrobeId: loom.protagonistWardrobeId || null,
                      expression: '',
                      continuityNotes: '',
                    },
                  ],
                })}
              >
                Add canonical protagonist to visual cast
              </button>
            )}
            {(universe?.characters || []).map((character) => {
              const appearance = form.visualCanon.characterAppearances
                .find((item) => item.characterId === character.id);
              const reference = characterReferenceInfo(character);
              const canonicalWardrobeLocked = character.id === canonicalProtagonistId
                && loom.protagonistWardrobeLocked === true
                && Boolean(loom.protagonistWardrobeId);
              const wardrobeValue = canonicalWardrobeLocked
                ? loom.protagonistWardrobeId
                : appearance?.wardrobeId || '';
              return (
                <div key={character.id} className="rounded bg-port-bg-subtle p-2 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <label className="flex items-center gap-2 text-xs" htmlFor={`loom-canon-character-${character.id}`}>
                      <input
                        id={`loom-canon-character-${character.id}`}
                        aria-label={character.name}
                        type="checkbox"
                        checked={Boolean(appearance)}
                        onChange={(event) => updateVisualCanon({
                          characterAppearances: event.target.checked
                            ? [...form.visualCanon.characterAppearances, {
                              characterId: character.id,
                              wardrobeId: character.id === canonicalProtagonistId
                                ? loom.protagonistWardrobeId || null
                                : null,
                              expression: '',
                              continuityNotes: '',
                            }]
                            : form.visualCanon.characterAppearances.filter((item) => item.characterId !== character.id),
                        })}
                      />
                      {character.name}
                    </label>
                    <span className={`text-[10px] ${reference.identityPackReady ? 'text-port-success' : 'text-port-warning'}`}>
                      {reference.identityPackReady
                        ? 'Identity pack ready'
                        : reference.sheetCount
                          ? `Sheet ready · identity missing ${reference.missingIdentityRoles.join(', ')}`
                          : 'Needs character sheet'}
                    </span>
                  </div>
                  {appearance && (character.wardrobes || []).length > 0 && (
                    <select
                      className={fieldClass}
                      aria-label={`${character.name} wardrobe`}
                      value={wardrobeValue}
                      disabled={canonicalWardrobeLocked}
                      onChange={(event) => updateVisualCanon({
                        characterAppearances: form.visualCanon.characterAppearances.map((item) => (
                          item.characterId === character.id ? { ...item, wardrobeId: event.target.value || null } : item
                        )),
                      })}
                    >
                      <option value="">Default wardrobe</option>
                      {wardrobeValue && !character.wardrobes.some((wardrobe) => wardrobe.id === wardrobeValue) && (
                        <option value={wardrobeValue}>Missing wardrobe ({wardrobeValue})</option>
                      )}
                      {character.wardrobes.map((wardrobe) => (
                        <option key={wardrobe.id} value={wardrobe.id}>{wardrobe.name || wardrobe.label || 'Wardrobe'}</option>
                      ))}
                    </select>
                  )}
                  {appearance && canonicalWardrobeLocked && (
                    <p className="text-[11px] text-port-accent">Locked to the loom&apos;s canonical protagonist wardrobe.</p>
                  )}
                  {appearance && form.visualCanon.mode === 'draft' && (
                    <div className="flex items-center gap-2 text-xs">
                      {appearance.referenceImage && <MediaImage thumbnail src={`/data/images/${appearance.referenceImage}`} alt={`${character.name} draft reference`} className="h-14 w-14 rounded object-cover" />}
                      <button type="button" className="min-h-11 text-port-accent hover:underline" onClick={() => setReferenceCharacterId(character.id)}>Choose draft character reference</button>
                    </div>
                  )}
                  {appearance && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        className={fieldClass}
                        aria-label={`${character.name} expression`}
                        placeholder="Expression"
                        value={appearance.expression || ''}
                        onChange={(event) => setForm((current) => ({
                          ...current,
                          visualCanon: {
                            ...current.visualCanon,
                            characterAppearances: current.visualCanon.characterAppearances.map((item) => (
                              item.characterId === character.id ? { ...item, expression: event.target.value } : item
                            )),
                          },
                        }))}
                        onBlur={() => patchNode({ visualCanon: form.visualCanon })}
                      />
                      <input
                        className={fieldClass}
                        aria-label={`${character.name} continuity notes`}
                        placeholder="Continuity notes"
                        value={appearance.continuityNotes || ''}
                        onChange={(event) => setForm((current) => ({
                          ...current,
                          visualCanon: {
                            ...current.visualCanon,
                            characterAppearances: current.visualCanon.characterAppearances.map((item) => (
                              item.characterId === character.id ? { ...item, continuityNotes: event.target.value } : item
                            )),
                          },
                        }))}
                        onBlur={() => patchNode({ visualCanon: form.visualCanon })}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
          <GalleryImagePicker open={Boolean(referenceCharacterId)} onClose={() => setReferenceCharacterId(null)} onSelect={(image) => {
            const visualCanon = { ...form.visualCanon, characterAppearances: form.visualCanon.characterAppearances.map((appearance) => appearance.characterId === referenceCharacterId ? { ...appearance, referenceImage: image.filename } : appearance) };
            setForm((current) => ({ ...current, visualCanon }));
            patchNode({ visualCanon });
          }} />

          <FormField label="Location" labelClassName={labelClass}>
            <select
              className={fieldClass}
              value={form.visualCanon.placeId || ''}
              onChange={(event) => updateVisualCanon({ placeId: event.target.value || null })}
            >
              <option value="">No bound location</option>
              {(universe?.places || []).map((place) => (
                <option key={place.id} value={place.id}>{place.name || place.slugline}</option>
              ))}
            </select>
          </FormField>

          {(universe?.objects || []).length > 0 && (
            <fieldset className="space-y-1">
              <legend className={labelClass}>Props and objects</legend>
              {universe.objects.map((object) => (
                <label key={object.id} className="flex items-center gap-2 text-xs" htmlFor={`loom-canon-object-${object.id}`}>
                  <input
                    id={`loom-canon-object-${object.id}`}
                    aria-label={object.name}
                    type="checkbox"
                    checked={form.visualCanon.objectIds.includes(object.id)}
                    onChange={(event) => updateVisualCanon({
                      objectIds: event.target.checked
                        ? [...form.visualCanon.objectIds, object.id]
                        : form.visualCanon.objectIds.filter((id) => id !== object.id),
                    })}
                  />
                  {object.name}
                </label>
              ))}
            </fieldset>
          )}

          <FormField label="Continuity source" labelClassName={labelClass}>
            <select
              className={fieldClass}
              value={form.visualCanon.continuitySourceNodeId || ''}
              onChange={(event) => updateVisualCanon({ continuitySourceNodeId: event.target.value || null })}
            >
              <option value="">Automatic (only for one incoming scene)</option>
              {otherNodes.filter((candidate) => candidate.transitions?.some((transition) => transition.targetNodeId === node.id))
                .map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title || 'Untitled scene'}</option>)}
            </select>
          </FormField>

          <FormField label="Shot continuity notes" labelClassName={labelClass}>
            <textarea
              rows={2}
              className={fieldClass}
              value={form.visualCanon.shotNotes || ''}
              onChange={(event) => setForm((current) => ({
                ...current, visualCanon: { ...current.visualCanon, shotNotes: event.target.value },
              }))}
              onBlur={() => patchNode({ visualCanon: form.visualCanon })}
            />
          </FormField>


        </div>
      )}
    </div>
  );
}
