import BibleSection, { BibleAiBadge } from './BibleSection';
import {
  CHARACTER_ARC_TYPES,
  CHARACTER_FRAMEWORK_EDITOR_FIELDS,
  CHARACTER_MOTIVATIONS_FIELD,
  CHARACTER_SECRETS_FIELD,
} from '../../lib/characterFramework';
import {
  PsychologyFields,
  RelationshipLinkRows,
  SliderFields,
  marshalPsychology,
  marshalRelationshipLinks,
  marshalSliders,
  seedPsychology,
  seedRelationshipLinks,
  seedSliders,
} from './CharacterFrameworkEditors';
import {
  listWritersRoomCharacters,
  createWritersRoomCharacter,
  updateWritersRoomCharacter,
  deleteWritersRoomCharacter,
} from '../../services/apiWritersRoom';

// Adapter over the shared narrative-framework definitions (#6417): the same
// Ghost → Wound → Lie → Need → Want copy the Universe cast editor renders,
// mapped onto BibleSection's compact field config. Deliberately NOT a copy of
// the universe editor — the media / voice / identity-pack surfaces stay there.
const ARC_TYPE_HINTS = Object.freeze({
  positive: 'positive — overcomes the Lie',
  negative: 'negative — consumed by the Lie',
  flat: 'flat — holds the truth, changes the world',
});
const FRAMEWORK_FIELDS = [
  { key: CHARACTER_MOTIVATIONS_FIELD.name, label: CHARACTER_MOTIVATIONS_FIELD.label, placeholder: CHARACTER_MOTIVATIONS_FIELD.placeholder, kind: 'multiline', rows: 2, heading: 'Character framework' },
  ...CHARACTER_FRAMEWORK_EDITOR_FIELDS.map((f) => ({ key: f.name, label: f.label, placeholder: f.placeholder, kind: 'multiline', rows: 2 })),
  {
    key: 'arcType',
    label: 'Arc type',
    placeholder: 'unset',
    kind: 'select',
    options: CHARACTER_ARC_TYPES.map((value) => ({ value, label: ARC_TYPE_HINTS[value] || value })),
  },
  { key: CHARACTER_SECRETS_FIELD.name, label: `${CHARACTER_SECRETS_FIELD.label} (one per line)`, placeholder: CHARACTER_SECRETS_FIELD.placeholder, kind: 'lines', rows: 3 },
  // The three structured surfaces, each rendered by its own editor rather than
  // by BibleSection's flat text/select controls. Same descriptors the Universe
  // cast editor uses; see CharacterFrameworkEditors.jsx.
  {
    key: 'sliders',
    kind: 'custom',
    heading: 'Three sliders (proactivity · likability · competence)',
    seed: seedSliders,
    marshal: marshalSliders,
    Component: SliderFields,
  },
  {
    key: 'psychology',
    kind: 'custom',
    heading: 'Psychology — theory of control & drives',
    seed: seedPsychology,
    marshal: marshalPsychology,
    Component: PsychologyFields,
  },
  {
    key: 'relationshipLinks',
    kind: 'custom',
    heading: 'Relationships',
    seed: seedRelationshipLinks,
    marshal: marshalRelationshipLinks,
    Component: RelationshipLinkRows,
  },
];
// The framework is optional by design — a character with no Ghost isn't
// incomplete — so it stays out of the row's "Missing: …" warning, which
// exists to flag the render-critical fields.
const FRAMEWORK_KEYS = FRAMEWORK_FIELDS.map((f) => f.key);

const CHARACTER_CONFIG = {
  icon: null,
  countLabel: (n) => `${n} character${n === 1 ? '' : 's'} · Edits persist across re-runs and feed image gen.`,
  emptyText: 'No profiles yet. Click "Refresh from prose" above to extract them, or add one manually.',
  editButtonTitle: 'Edit profile',
  primary: {
    key: 'name',
    label: 'Name',
    placeholder: 'Character name',
    inputExtraClass: 'font-semibold',
  },
  fields: [
    { key: 'aliases', label: 'Aliases', placeholder: 'nicknames, titles (comma-separated)', kind: 'csv' },
    { key: 'role', label: 'Role', placeholder: 'protagonist, mentor, antagonist…', kind: 'text' },
    { key: 'physicalDescription', label: 'Physical description', placeholder: 'Age, build, hair, eyes, distinctive features, signature wardrobe. Used directly in image-gen prompts.', kind: 'multiline', rows: 3 },
    { key: 'personality', label: 'Personality', placeholder: 'Temperament, voice, quirks', kind: 'multiline', rows: 2 },
    { key: 'background', label: 'Background', placeholder: 'Who they are, where they come from', kind: 'multiline', rows: 2 },
    { key: 'notes', label: 'Notes', placeholder: 'Anything else worth tracking', kind: 'multiline', rows: 2 },
    ...FRAMEWORK_FIELDS,
  ],
  bodyField: 'physicalDescription',
  bodyEmptyText: 'No physical description — image gen will use scene context only',
  detailBlocks: [
    { key: 'want', label: 'Want', marginClass: 'mt-1' },
    { key: 'need', label: 'Need', marginClass: '' },
  ],
  blanksExcludeKeys: ['notes', 'aliases', ...FRAMEWORK_KEYS],
  renderTitle: (item, { light }) => (
    <span className={`font-semibold ${light ? 'text-gray-900' : 'text-white'}`}>{item.name}</span>
  ),
  renderHeaderExtras: (item) => (
    <>
      {item.role && <span className="text-[9px] uppercase tracking-wider text-port-accent">{item.role}</span>}
      {item.source === 'ai' && <BibleAiBadge />}
      {item.aliases?.length > 0 && (
        <span className="text-[10px] text-gray-500 truncate">aka {item.aliases.join(', ')}</span>
      )}
    </>
  ),
  getDisplayName: (item) => item.name,
  getSortKey: (item) => item.name || '',
  validate: (draft) => (draft.name.trim() ? null : 'Name is required'),
  api: {
    list: listWritersRoomCharacters,
    create: createWritersRoomCharacter,
    update: updateWritersRoomCharacter,
    remove: deleteWritersRoomCharacter,
  },
};

// Editable character bible — persistent across analysis runs and consumed by
// image gen to inject physicalDescription into per-scene prompts. See
// BibleSection.jsx for the shared implementation these three configure.
//
// Controlled vs. uncontrolled: caller may pass `characters` to keep multiple
// mounts in sync (e.g. drawer + storyboard chip count). When omitted we fetch
// and own the list so this can stand alone.
export default function CharactersBible({ workId, characters, onCharactersChange, readingTheme = 'dark', hotRefId = null }) {
  return (
    <BibleSection
      workId={workId}
      items={characters}
      onItemsChange={onCharactersChange}
      readingTheme={readingTheme}
      hotRefId={hotRefId}
      config={CHARACTER_CONFIG}
    />
  );
}
