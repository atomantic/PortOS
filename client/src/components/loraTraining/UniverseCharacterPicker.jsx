/**
 * Universe → character cascading select. Shared by the "New dataset" dialog
 * and the dataset-reassignment dialog so both pick a (universeId, entryId)
 * pair through identical loading/empty states. The parent owns the selected
 * ids; this just renders the two <select>s and loads the option lists.
 *
 * When the universe changes the parent is responsible for clearing entryId
 * (a stale character id from the previous universe must not survive) — the
 * `onUniverseChange` handler should reset it.
 */

import { useState, useEffect } from 'react';
import { listUniverses, getUniverse } from '../../services/api';

export default function UniverseCharacterPicker({
  universeId,
  entryId,
  onUniverseChange,
  onEntryChange,
  idPrefix = 'ucp',
  disabledEntryIds = [],
}) {
  const [universes, setUniverses] = useState(null);
  const [characters, setCharacters] = useState(null);

  useEffect(() => {
    listUniverses().then((list) => setUniverses(Array.isArray(list) ? list : []))
      .catch(() => setUniverses([]));
  }, []);

  useEffect(() => {
    if (!universeId) { setCharacters(null); return; }
    setCharacters(null);
    getUniverse(universeId, { silent: true })
      .then((u) => setCharacters(Array.isArray(u?.characters) ? u.characters : []))
      .catch(() => setCharacters([]));
  }, [universeId]);

  const disabled = new Set(disabledEntryIds);

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
        <div>
          <label htmlFor={`${idPrefix}-character`} className="block text-sm text-gray-400 mb-1">Character</label>
          <select
            id={`${idPrefix}-character`}
            value={entryId}
            onChange={(e) => onEntryChange(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white"
          >
            <option value="">{characters === null ? 'Loading…' : characters.length ? 'Pick a character' : 'No characters in this universe'}</option>
            {(characters || []).map((c) => (
              <option key={c.id} value={c.id} disabled={disabled.has(c.id)}>
                {c.name}{disabled.has(c.id) ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}
