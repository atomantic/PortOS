// The Profile tab of the catalog ingredient editor: the type's sheet fields
// (or the character editor), forms, reveal timing, object attachments, source
// scraps and relations. Every edit writes the page's draft; Save persists it.
//
// `gates` carries the page's busy/dirty flags (see CharacterProfile).

import { RevealTimingField } from '../../pipeline/CanonCard';
import ObjectAttachmentsEditor from '../../universe/ObjectAttachmentsEditor';
import TagPicker from '../../TagPicker';
import GenericIngredientFields from '../../GenericIngredientFields';
import CatalogImagePreview from '../CatalogImagePreview';
import CatalogFormsEditor from '../CatalogFormsEditor';
import { getCatalogType } from '../../../lib/catalogTypes';
import { FORM_TYPES } from './ingredientDraft';
import { SheetField, SheetSection } from './SheetFields';
import EditableListFields from './EditableListFields';
import CharacterProfile from './CharacterProfile';
import SourcesPanel from './SourcesPanel';
import RelationsPanel from './RelationsPanel';

export default function IngredientProfileTab({ hidden, record, draft, owner, gates, typeDef, coverUrl, videoDescriptionLimit, relations, onAddRelation, onRemoveRelation, onGenerated, showReferenceSheet, onCanonChanged }) {
  const { name, setName, tags, setTags, payload, updatePayload, patchPayload } = draft;
  const readOnly = gates.readOnly;
  const fields = typeDef.editorFields || getCatalogType('idea').editorFields;
  // Grouped "character sheet" sections for the rich canon types
  // (character/place/object); light types (idea/scene/concept) have none and
  // fall back to the flat field list below.
  const sections = typeDef.editorSections || null;
  const editableLists = typeDef.editableListFields || [];
  // A user-defined type has no hardcoded editor sections and carries
  // generically-shaped editorFields ({ key, label, widget }); render the
  // generic field renderer for it. System types keep their existing branches.
  const isUserType = typeDef.system === false;
  const isCharacter = record.type === 'character';
  return (
    <div hidden={hidden} className="space-y-4">
      {!isCharacter && <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6 space-y-4">
        <div className={coverUrl ? 'grid grid-cols-1 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] gap-5 items-start' : ''}>
          {coverUrl && (
            <figure className="min-w-0 rounded-lg border border-port-border bg-port-bg overflow-hidden">
              <CatalogImagePreview key={coverUrl} src={coverUrl} fallbackSrc={coverUrl.replace('/data/images/', '/data/image-refs/')}
                alt={`${record.name || 'Ingredient'} cover`} className="w-full max-h-80 object-contain" loading="eager" />
              <figcaption className="text-xs text-gray-400 p-2">Cover image · select to enlarge</figcaption>
            </figure>
          )}
          <fieldset disabled={readOnly} className="min-w-0 space-y-4">
            <div>
              <label htmlFor="ingredient-name" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Name</label>
              <input id="ingredient-name" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={200}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent" />
            </div>
            <div>
              <label htmlFor="ingredient-tags" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Tags
              </label>
              <TagPicker id="ingredient-tags" value={tags} onChange={setTags}
                placeholder="mentor, antagonist, season-1" />
            </div>
          </fieldset>
        </div>
        <fieldset disabled={readOnly} className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          {isUserType
            ? <GenericIngredientFields fields={fields} payload={payload} onChange={updatePayload} />
            : sections
            ? sections.map((section) => (
                <SheetSection key={section.title} title={section.title}
                  fields={section.fields} payload={payload} onChange={updatePayload} videoDescriptionLimit={videoDescriptionLimit} />
              ))
            : fields.map(([key, label, kind]) => (
                <SheetField key={key} fieldKey={key} label={label} kind={kind}
                  value={payload[key] ?? ''} onChange={updatePayload} videoDescriptionLimit={videoDescriptionLimit} />
              ))}
        </fieldset>

        {/* Structured array-field editors (aliases / color palette / stats).
            Driven by the type's registry-declared `editableListFields`; the
            same durable catalog row the Universe Builder canon surface edits.
            Light/user types declare none and skip this entirely. */}
        {!isUserType && Array.isArray(typeDef.editableListFields) && typeDef.editableListFields.length > 0 && (
          <fieldset disabled={readOnly}><EditableListFields fields={editableLists} payload={payload} onChange={updatePayload} /></fieldset>
        )}
      </div>}

      {!isCharacter && FORM_TYPES.has(record.type) && (
        <fieldset disabled={readOnly} className="min-w-0">
          <CatalogFormsEditor type={record.type} payload={payload} onChange={updatePayload} videoDescriptionLimit={videoDescriptionLimit} />
        </fieldset>
      )}
      {!isCharacter && FORM_TYPES.has(record.type) && <RevealTimingField entry={{ ...payload, id: record.id }}
        editable={!readOnly && payload.locked !== true} onPatch={patchPayload} />}

      {isCharacter && <CharacterProfile record={record} draft={draft} owner={owner} gates={gates} typeDef={typeDef}
        coverUrl={coverUrl} videoDescriptionLimit={videoDescriptionLimit} relations={relations}
        onAddRelation={onAddRelation} onRemoveRelation={onRemoveRelation} onGenerated={onGenerated}
        showReferenceSheet={showReferenceSheet} onCanonChanged={onCanonChanged} />}

      {record.type === 'object' && <ObjectAttachmentsEditor entry={{ ...payload, id: record.id, name }}
        characters={owner.universe?.characters || []} disabled={readOnly || payload.locked === true}
        onPatch={patchPayload} />}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SourcesPanel sources={record.sources} evidence={payload?.evidence} />
      </div>

      <RelationsPanel
        record={record}
        relations={relations}
        evidence={payload?.evidence}
        readOnly={readOnly} retainedSourceId={record.sharedIdentity?.sourceId}
        onAdd={onAddRelation}
        onRemove={onRemoveRelation}
      />
    </div>
  );
}
