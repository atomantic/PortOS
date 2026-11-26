// The Profile tab body for a character ingredient: the shared character sheet
// editor wired to the page's draft, with identity controls, owning-universe
// canon actions, image generation, family, forms and reveal timing.
//
// `gates` carries the page's busy/dirty flags: { readOnly, characterActionBusy,
// setCharacterActionBusy, isDirty, saving, unlocking, lookSaving, externalDetails }.

import CharacterDetailEditor from '../../universe/CharacterDetailEditor';
import { RevealTimingField } from '../../pipeline/CanonCard';
import TagPicker from '../../TagPicker';
import GenerateImageControl from '../GenerateImageControl';
import CatalogImagePreview from '../CatalogImagePreview';
import { ReferenceSheetPanel } from '../CatalogSheetsPanel';
import CharacterCanonActions from '../CharacterCanonActions';
import CatalogFormsEditor from '../CatalogFormsEditor';
import CatalogFamilyPicker from '../CatalogFamilyPicker';
import { isFamilyRelationKind } from '../../../lib/catalogTypes';
import { buildGenerationPromptSeed } from '../../../lib/catalogImagePrompt';
import EditableListFields from './EditableListFields';

export default function CharacterProfile({ record, draft, owner, gates, typeDef, coverUrl, videoDescriptionLimit, relations, onAddRelation, onRemoveRelation, onGenerated, showReferenceSheet, onCanonChanged }) {
  const { name, setName, tags, setTags, payload, updatePayload, patchPayload } = draft;
  const { readOnly, characterActionBusy, isDirty, saving, unlocking, lookSaving, externalDetails } = gates;
  const universeRef = record.universeContext?.owner || null;
  const editableLists = typeDef.editableListFields || [];
  // Unsaved description/tag edits feed the next render's default prompt (#1809).
  const genDescription = buildGenerationPromptSeed(payload, typeDef, tags);
  return (
    <CharacterDetailEditor
      draftMode="change" navigationId={record.id} onPageChange={owner.onCharacterPageChange}
      videoDescriptionLimit={videoDescriptionLimit}
      entry={{ ...payload, id: owner.character?.id || record.id, name }}
      universeId={owner.character ? owner.universeId : null} characters={owner.universe?.characters || []}
      contextLoading={!!owner.universeId && !owner.universe && !owner.error}
      disabled={readOnly || characterActionBusy} actionsDisabled={payload.locked === true || isDirty || saving || unlocking || lookSaving}
      onPatch={patchPayload}
      saveHint={null}
      portrait={coverUrl ? <CatalogImagePreview key={coverUrl} src={coverUrl} fallbackSrc={coverUrl.replace('/data/images/', '/data/image-refs/')}
        alt={`${record.name || 'Character'} cover`} className="w-full max-h-64 object-contain rounded" loading="eager" /> : null}
      identityControls={<div className="space-y-3">
        <div><label htmlFor="ingredient-name" className="block text-xs text-gray-400 mb-1">Name</label>
          <input id="ingredient-name" value={name} maxLength={200} disabled={readOnly || characterActionBusy} onChange={event => setName(event.target.value)}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" /></div>
        <div><label htmlFor="ingredient-tags" className="block text-xs text-gray-400 mb-1">Tags</label>
          <fieldset disabled={readOnly || characterActionBusy}><TagPicker id="ingredient-tags" value={tags} onChange={setTags} /></fieldset></div>
        {owner.universeId && !owner.requested && <button type="button" onClick={owner.request}
          className="min-h-11 text-xs text-port-accent">Load universe creative tools</button>}
        {owner.canonMissing && <p role="alert" className="text-xs text-port-warning">
          {name || 'This character'} isn’t in {owner.universe?.name || 'its universe'}’s cast, so its story, voice and sheet tools are off.
          {!readOnly && <button type="button" disabled={owner.joining} onClick={owner.join}
            className="ml-1 min-h-11 underline disabled:opacity-50">{owner.joining ? 'Adding…' : 'Add to cast'}</button>}</p>}
        {owner.error && <p role="alert" className="text-xs text-port-warning">{owner.error}
          <button type="button" onClick={owner.retry} className="ml-1 underline">Retry context</button></p>}
        {owner.character && <CharacterCanonActions key={owner.character.id} universe={owner.universe} entry={owner.character}
          applyDisabled={readOnly || payload.locked === true}
          disabled={readOnly || payload.locked === true || isDirty || saving || unlocking || lookSaving || externalDetails}
          onPendingChange={gates.setCharacterActionBusy} onPatch={patchPayload}
          onChanged={updated => {
            if (updated) owner.setUniverse(updated);
            onCanonChanged();
          }} />}
      </div>}
      primaryActions={<div className="flex flex-wrap items-start gap-2">
        <GenerateImageControl key={record.id} ingredientId={record.id} name={name} description={genDescription}
          universeId={universeRef?.refId || null} onComplete={onGenerated}
          disabled={readOnly || payload.locked === true || characterActionBusy || saving || unlocking || lookSaving || externalDetails} />
      </div>}
      storyExtra={<fieldset disabled={readOnly || characterActionBusy}><EditableListFields fields={editableLists.filter(field => field.key === 'aliases')} payload={payload} onChange={updatePayload} /></fieldset>}
    >
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <CatalogFamilyPicker selfName={name} excludeIds={[record.id]} disabled={readOnly || characterActionBusy}
          items={relations.outbound.filter((r) => isFamilyRelationKind(r.kind)).map((r) => ({ kind: r.kind, id: r.toId, name: r.other?.name }))}
          inbound={relations.inbound.filter((r) => isFamilyRelationKind(r.kind)).map((r) => ({ kind: r.kind, id: r.fromId, name: r.other?.name }))}
          onAdd={(kind, target) => onAddRelation(target, kind)} onRemove={(item) => onRemoveRelation(item.id, item.kind)} />
      </div>
      <fieldset disabled={readOnly || characterActionBusy}><CatalogFormsEditor type={record.type} payload={payload} onChange={updatePayload} videoDescriptionLimit={videoDescriptionLimit} /></fieldset>
      <RevealTimingField entry={{ ...payload, id: record.id }} editable={!readOnly && !characterActionBusy && payload.locked !== true}
        onPatch={patchPayload} />
      {showReferenceSheet && <ReferenceSheetPanel payload={payload} recordId={record.id} />}
      <div className="bg-port-card border border-port-border rounded-lg p-3">
        <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Character LoRA</div>
      </div>
    </CharacterDetailEditor>
  );
}
