import { MapPin } from 'lucide-react';
import BibleSection, { BibleAiBadge } from './BibleSection';
import {
  listWritersRoomPlaces,
  createWritersRoomPlace,
  updateWritersRoomPlace,
  deleteWritersRoomPlace,
} from '../../services/apiWritersRoom';

const PLACE_CONFIG = {
  icon: MapPin,
  iconClassName: 'text-port-accent shrink-0',
  countLabel: (n) => `${n} location${n === 1 ? '' : 's'} · Edits persist across re-runs and feed image gen.`,
  emptyText: 'No locations yet. Click "Refresh from prose" above to extract them, or add one manually.',
  editButtonTitle: 'Edit place',
  primary: {
    key: 'slugline',
    label: 'Slugline',
    placeholder: 'INT. KITCHEN — NIGHT',
    inputExtraClass: 'font-mono uppercase',
  },
  fields: [
    { key: 'name', label: 'Name (optional, human-readable)', placeholder: "The Kitchen, Curry O'City…", kind: 'text', trim: true },
    { key: 'description', label: 'Description', placeholder: 'Architecture, scale, materials, lighting sources, recurring set-dressing. Used directly in image-gen prompts.', kind: 'multiline', rows: 3 },
    { key: 'palette', label: 'Palette', placeholder: 'Comma-separated dominant colors / lighting cues', kind: 'text' },
    { key: 'era', label: 'Era', placeholder: 'near-future, 1950s noir, present day…', kind: 'text' },
    { key: 'weather', label: 'Weather / mood', placeholder: 'Recurring atmospheric conditions inside this place', kind: 'text' },
    { key: 'recurringDetails', label: 'Recurring details', placeholder: 'Distinctive props or fixtures the prose returns to', kind: 'multiline', rows: 2 },
    { key: 'notes', label: 'Notes', placeholder: 'Anything else worth tracking', kind: 'multiline', rows: 2 },
  ],
  bodyField: 'description',
  bodyEmptyText: "No description — image gen will use the scene's visualPrompt only",
  detailBlocks: [
    { key: 'palette', label: 'Palette', marginClass: 'mt-1' },
    { key: 'recurringDetails', label: 'Anchors', marginClass: 'mt-0.5' },
  ],
  blanksExcludeKeys: ['notes', 'name'],
  renderTitle: (item, { light }) => (
    item.slugline ? (
      <span className={`font-mono text-[11px] uppercase ${light ? 'text-gray-900' : 'text-white'}`}>{item.slugline}</span>
    ) : (
      <span className={`font-semibold ${light ? 'text-gray-900' : 'text-white'}`}>{item.name}</span>
    )
  ),
  renderHeaderExtras: (item) => (
    <>
      {item.slugline && item.name && item.name !== item.slugline && (
        <span className="text-[10px] text-gray-500 truncate">aka {item.name}</span>
      )}
      {item.era && <span className="text-[9px] uppercase tracking-wider text-port-accent">{item.era}</span>}
      {item.source === 'ai' && <BibleAiBadge />}
    </>
  ),
  getDisplayName: (item) => item.slugline || item.name,
  getSortKey: (item) => item.slugline || item.name || '',
  validate: (draft) => (draft.slugline.trim() || draft.name.trim() ? null : 'Slugline or name is required'),
  api: {
    list: listWritersRoomPlaces,
    create: createWritersRoomPlace,
    update: updateWritersRoomPlace,
    remove: deleteWritersRoomPlace,
  },
};

// Editable places/world bible — persistent across analysis runs and consumed
// by image gen to inject location descriptions into per-scene prompts. See
// BibleSection.jsx for the shared implementation these three configure.
//
// Controlled vs. uncontrolled: caller may pass `places` to keep multiple
// mounts in sync (e.g. drawer + storyboard chip count). When omitted we fetch
// and own the list so this can stand alone.
export default function PlacesBible({ workId, places, onPlacesChange, readingTheme = 'dark', hotRefId = null }) {
  return (
    <BibleSection
      workId={workId}
      items={places}
      onItemsChange={onPlacesChange}
      readingTheme={readingTheme}
      hotRefId={hotRefId}
      config={PLACE_CONFIG}
    />
  );
}
