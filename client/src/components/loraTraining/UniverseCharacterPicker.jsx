/**
 * Universe → bible-subject cascading select. Shared by the "New dataset" dialog
 * and the dataset-reassignment dialog so both pick a (universeId, entryKind, entryId)
 * pair through identical loading/empty states. The parent owns the selected
 * ids; this just renders the two <select>s and loads the option lists.
 *
 * When the universe changes the parent is responsible for clearing entryId
 * (a stale subject id from the previous universe must not survive) — the
 * `onUniverseChange` handler should reset it.
 */

import { useCallback } from 'react';
import useListResource from '../../hooks/useListResource';
import ListLoadError from '../ui/ListLoadError';
import { listUniverses, getUniverse } from '../../services/api';

const ENTRY_KINDS = [
  { value: 'characters', label: 'Character', empty: 'No characters in this universe', pick: 'Pick a character' },
  { value: 'objects', label: 'Object', empty: 'No objects in this universe', pick: 'Pick an object' },
  { value: 'places', label: 'Place', empty: 'No places in this universe', pick: 'Pick a place' },
];
const fetchUniverses = () => listUniverses({ silent: true });
const kindConfig = (entryKind) => ENTRY_KINDS.find((k) => k.value === entryKind) || ENTRY_KINDS[0];

export default function UniverseCharacterPicker({
  universeId,
  entryKind = 'characters',
  entryId,
  onUniverseChange,
  onEntryKindChange = () => {},
  onEntryChange,
  idPrefix = 'ucp',
  disabledEntryIds = [],
}) {
  const { items: universes, state: universesState, error: universesError, retry: retryUniverses } = useListResource(fetchUniverses);
  // One universe is a single object; a one-item list gives its read the same
  // loading | ready | error states, so a failed read never renders as an empty
  // subject list.
  const fetchUniverse = useCallback(() => getUniverse(universeId, { silent: true }).then((u) => [u || {}]), [universeId]);
  const { items: universeItems, state: universeState, error: universeError, retry: retryUniverse } = useListResource(fetchUniverse, { enabled: !!universeId });
  const entries = universeState === 'ready' && Array.isArray(universeItems[0]?.[entryKind]) ? universeItems[0][entryKind] : [];

  const disabled = new Set(disabledEntryIds);
  const kind = kindConfig(entryKind);

  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-universe`} className="block text-sm text-gray-400 mb-1">Universe</label>
        <select
          id={`${idPrefix}-universe`}
          value={universeId}
          onChange={(e) => onUniverseChange(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white"
        >
          <option value="">{universesState === 'loading' ? 'Loading…' : 'Pick a universe'}</option>
          {universes.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        {universesState === 'error' && <ListLoadError className="mt-1" what="universes" error={universesError} onRetry={retryUniverses} />}
      </div>
      {universeId && (
        <>
          <div>
            <label htmlFor={`${idPrefix}-entry-kind`} className="block text-sm text-gray-400 mb-1">Subject type</label>
            <select
              id={`${idPrefix}-entry-kind`}
              value={entryKind}
              onChange={(e) => onEntryKindChange(e.target.value)}
              className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white"
            >
              {ENTRY_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-entry`} className="block text-sm text-gray-400 mb-1">{kind.label}</label>
            <select
              id={`${idPrefix}-entry`}
              value={entryId}
              onChange={(e) => onEntryChange(e.target.value)}
              className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white"
            >
              <option value="">
                {universeState === 'loading' ? 'Loading…' : universeState === 'error' ? 'Unavailable' : entries.length ? kind.pick : kind.empty}
              </option>
              {entries.map((entry) => (
                <option key={entry.id} value={entry.id} disabled={disabled.has(entry.id)}>
                  {entry.name || entry.slugline || entry.id}{disabled.has(entry.id) ? ' (current)' : ''}
                </option>
              ))}
            </select>
            {universeState === 'error' && <ListLoadError className="mt-1" what="the universe" error={universeError} onRetry={retryUniverse} />}
          </div>
        </>
      )}
    </>
  );
}
