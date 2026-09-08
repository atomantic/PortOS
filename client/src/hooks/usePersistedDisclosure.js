import { useCallback, useState } from 'react';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage.js';

/**
 * Disclosure open/closed state remembered across mounts (and reloads) under a
 * localStorage key.
 *
 * `'1'` / `'0'` rather than JSON so the stored bytes are readable and a
 * corrupted entry is unambiguous. Absent — never toggled — is NOT "closed": it
 * falls through to the caller's `defaultOpen`, so a card that ships collapsed
 * can later ship expanded without every install that never touched it being
 * pinned to the old default.
 *
 * `storageKey` is read once, at mount. A caller that swaps the key per record
 * wants a `key` on the component instead; the keys here name a card, not a row.
 */
export default function usePersistedDisclosure(storageKey, defaultOpen = false) {
  const [open, setOpen] = useState(() => {
    const raw = safeReadStorage(storageKey);
    if (raw !== '1' && raw !== '0') return defaultOpen;
    return raw === '1';
  });
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      safeWriteStorage(storageKey, next ? '1' : '0');
      return next;
    });
  }, [storageKey]);
  return [open, toggle];
}
