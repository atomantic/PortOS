import { Package } from 'lucide-react';
import BibleSection, { BibleAiBadge } from './BibleSection';
import {
  listWritersRoomObjects,
  createWritersRoomObject,
  updateWritersRoomObject,
  deleteWritersRoomObject,
} from '../../services/apiWritersRoom';

const OBJECT_CONFIG = {
  icon: Package,
  iconClassName: 'text-amber-400 shrink-0',
  countLabel: (n) => `${n} object${n === 1 ? '' : 's'} · Recurring symbolic items extracted from prose.`,
  emptyText: 'No recurring objects yet. Click "Refresh from prose" above to extract them, or add one manually.',
  editButtonTitle: 'Edit object',
  primary: {
    key: 'name',
    label: 'Name',
    placeholder: "the letter, the fedora, her grandmother's locket…",
    autoFocus: true,
  },
  fields: [
    { key: 'aliases', label: 'Aliases (comma-separated)', placeholder: 'the envelope, the note', kind: 'csv' },
    { key: 'description', label: 'Description', placeholder: 'Material, color, condition, distinguishing marks. Used in image-gen prompts when this object appears in a scene.', kind: 'multiline', rows: 3 },
    { key: 'significance', label: 'Significance', placeholder: 'Why does this object matter? What does it represent? How does its meaning evolve across scenes?', kind: 'multiline', rows: 2 },
    { key: 'notes', label: 'Notes', placeholder: 'Anything else worth tracking', kind: 'multiline', rows: 2 },
  ],
  bodyField: 'description',
  bodyEmptyText: 'No description yet',
  detailBlocks: [
    { key: 'significance', label: 'Significance', marginClass: 'mt-1' },
  ],
  blanksExcludeKeys: ['notes', 'aliases'],
  renderTitle: (item, { light }) => (
    <span className={`font-semibold ${light ? 'text-gray-900' : 'text-white'}`}>{item.name}</span>
  ),
  renderHeaderExtras: (item) => (
    <>
      {item.aliases?.length > 0 && (
        <span className="text-[10px] text-gray-500 truncate">aka {item.aliases.join(', ')}</span>
      )}
      {item.source === 'ai' && <BibleAiBadge />}
    </>
  ),
  getDisplayName: (item) => item.name,
  getSortKey: (item) => item.name || '',
  validate: (draft) => (draft.name.trim() ? null : 'Name is required'),
  api: {
    list: listWritersRoomObjects,
    create: createWritersRoomObject,
    update: updateWritersRoomObject,
    remove: deleteWritersRoomObject,
  },
};

// Editable recurring-objects bible. Mirrors CharactersBible / PlacesBible —
// see BibleSection.jsx for the shared implementation these three configure.
// Distinct from analysis snapshots — this is the canonical roster that
// survives across `objects` analysis runs and accepts hand-edits.
export default function ObjectsBible({ workId, objects, onObjectsChange, readingTheme = 'dark', hotRefId = null }) {
  return (
    <BibleSection
      workId={workId}
      items={objects}
      onItemsChange={onObjectsChange}
      readingTheme={readingTheme}
      hotRefId={hotRefId}
      config={OBJECT_CONFIG}
    />
  );
}
