import { useState } from 'react';
import { updateSpriteRecord, deleteSpriteRecord } from '../services/apiSprites.js';

/**
 * Rename/delete state machine for a single sprite record, shared by the Library
 * catalog card and the Sprite Manager detail header so the two surfaces stay in
 * lock-step (same endpoints, same silent-toast + inline-error contract). The
 * caller owns the markup; this owns the mode/name/busy/error state and the two
 * mutations.
 *
 * `mode` is `'view' | 'rename' | 'confirm'`. `onRenamed` receives the updated
 * record; `onDeleted` receives the id. Both calls pass `{ silent: true }` (the
 * caller renders inline errors), so a failure sets `error` and stays in its
 * mode rather than toasting. On a successful delete the caller typically drops
 * the record from its list and unmounts this — so `busy` is only cleared on
 * failure, matching the catalog card's original behaviour.
 */
export default function useSpriteRecordCrud(record, { onRenamed, onDeleted } = {}) {
  const [mode, setMode] = useState('view');
  const [name, setName] = useState(record.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const cancel = () => { setMode('view'); setError(null); };
  const startRename = () => { setName(record.name || ''); setError(null); setMode('rename'); };
  const startDelete = () => { setError(null); setMode('confirm'); };

  const saveRename = () => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Name can’t be empty'); return; }
    if (trimmed === record.name) { cancel(); return; }
    setBusy(true);
    setError(null);
    updateSpriteRecord(record.id, { name: trimmed }, { silent: true })
      .then((updated) => { onRenamed?.(updated); setMode('view'); })
      .catch((err) => setError(err?.message || 'Rename failed'))
      .finally(() => setBusy(false));
  };

  const runDelete = () => {
    setBusy(true);
    setError(null);
    deleteSpriteRecord(record.id, { silent: true })
      .then(() => onDeleted?.(record.id))
      .catch((err) => { setError(err?.message || 'Delete failed'); setBusy(false); });
  };

  return { mode, name, setName, busy, error, cancel, startRename, startDelete, saveRename, runDelete };
}
