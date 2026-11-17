// The owning universe's context for a catalog ingredient: the universe (and,
// for a character, its canon cast entry), loaded on demand for the character
// story/voice pages and always for an object's attachment picker.

import { useCallback, useEffect, useState } from 'react';
import { linkCatalogIngredient } from '../../../services/apiCatalog';
import { getCanonCatalogContext } from '../../../services/canonCatalogContext';
import { getUniverse } from '../../../services/apiUniverseBuilder';

export default function useOwnerUniverse(record) {
  const [entryId, setEntryId] = useState(null);
  const [universe, setUniverse] = useState(null);
  const [error, setError] = useState(null);
  // Owned by a universe but not in its cast: re-reading the context cannot help,
  // so the page offers to add the record to that cast instead of a retry.
  const [canonMissing, setCanonMissing] = useState(false);
  const [joining, setJoining] = useState(false);
  const [contextVersion, setContextVersion] = useState(0);
  const [requested, setRequested] = useState(false);
  const onCharacterPageChange = useCallback(page => { if (page === 'story' || page === 'voice') setRequested(true); }, []);
  const universeId = record?.universeContext?.owner?.refId || null;
  useEffect(() => {
    let active = true;
    setUniverse(null); setEntryId(null); setError(null); setCanonMissing(false);
    if (!universeId || !requested && record?.type !== 'object') return;
    const load = record.type === 'character'
      ? getCanonCatalogContext(universeId, record.id, record.type, { silent: true })
      : getUniverse(universeId, { silent: true }).then(loaded => ({ universe: loaded }));
    load.then(({ universe: loaded, entry }) => { if (active) { setUniverse(loaded); setEntryId(entry?.id || null);
      if (record.type === 'character' && !entry) setCanonMissing(true); } })
      .catch(err => { if (active) setError(err.message || 'Could not load the owning universe’s character context.'); });
    return () => { active = false; };
  }, [universeId, requested, contextVersion, record?.type, record?.id]);
  const join = useCallback(() => {
    if (!record?.id || !universeId) return;
    setJoining(true);
    linkCatalogIngredient(record.id, { refKind: 'universe', refId: universeId, role: `canon-${record.type}` })
      .then(() => setContextVersion(previous => previous + 1))
      .catch(() => {})
      .finally(() => setJoining(false));
  }, [record?.id, record?.type, universeId]);

  return {
    universeId, universe, setUniverse,
    character: universe?.characters?.find((entry) => entry.id === entryId),
    error, canonMissing, joining, join,
    retry: () => setContextVersion(previous => previous + 1),
    requested, request: () => setRequested(true), onCharacterPageChange,
  };
}
