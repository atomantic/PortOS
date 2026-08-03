import BibleSection, { BibleAiBadge } from './BibleSection';
import {
  listWritersRoomCharacters,
  createWritersRoomCharacter,
  updateWritersRoomCharacter,
  deleteWritersRoomCharacter,
} from '../../services/apiWritersRoom';

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
  ],
  bodyField: 'physicalDescription',
  bodyEmptyText: 'No physical description — image gen will use scene context only',
  detailBlocks: [],
  blanksExcludeKeys: ['notes', 'aliases'],
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
