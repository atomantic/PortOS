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

import { useState, useEffect } from 'react';
import { listUniverses, getUniverse } from '../../services/api';

const ENTRY_KINDS = [
  { value: 'characters', label: 'Character', empty: 'No characters in this universe', pick: 'Pick a character' },
  { value: 'objects', label: 'Object', empty: 'No objects in this universe', pick: 'Pick an object' },
  { value: 'places', label: 'Place', empty: 'No places in this universe', pick: 'Pick a place' },
];
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
  const [universes, setUniverses] = useState(null);
  const [universe, setUniverse] = useState(null);
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    listUniverses().then((list) => setUniverses(Array.isArray(list) ? list : []))
      .catch(err => { console.warn('⚠️ Failed to load universes: ' + err.message); setUniverses([]); });
  }, []);

  useEffect(() => {
    if (!universeId) { setUniverse(null); setEntries(null); return; }
    setUniverse(null);
    setEntries(null);
    getUniverse(universeId, { silent: true })
      .then((u) => setUniverse(u || {}))
      .catch(err => { console.warn('⚠️ Failed to load universe: ' + err.message); setUniverse({}); });
  }, [universeId]);

  useEffect(() => {
    if (!universeId || !universe) return;
    setEntries(Array.isArray(universe?.[entryKind]) ? universe[entryKind] : []);
  }, [universeId, universe, entryKind]);

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
          <option value="">{universes === null ? 'Loading…' : 'Pick a universe'}</option>
          {(universes || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
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
              <option value="">{entries === null ? 'Loading…' : entries.length ? kind.pick : kind.empty}</option>
              {(entries || []).map((entry) => (
                <option key={entry.id} value={entry.id} disabled={disabled.has(entry.id)}>
                  {entry.name || entry.slugline || entry.id}{disabled.has(entry.id) ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </>
  );
}
