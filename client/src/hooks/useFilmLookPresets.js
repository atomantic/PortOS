import { useCallback, useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../services/apiSystem.js';
import { normalizeFilmLook } from '../lib/filmLook.js';
import toast from '../components/ui/Toast';

// One copy per page: every Film look panel, shot picker and gallery editor reads
// the same list, so a look saved in one shows in the others at once and the
// settings are fetched once, not once per shot card.
let presets = null; // null = not loaded yet (or the load failed: a later mount retries)
let confirmed = null; // the list the server last accepted
let loading = null;
let writeTail = Promise.resolve();
let generation = 0;
let refusedThrough = 0;
const listeners = new Set();

const publish = (next) => {
  presets = next;
  listeners.forEach((listener) => listener(next));
};

const load = () => {
  loading ||= getSettings({ silent: true })
    .then((settings) => {
      confirmed = Array.isArray(settings?.filmLookPresets) ? settings.filmLookPresets : [];
      publish(confirmed);
    })
    .catch(() => { loading = null; });
  return loading;
};

// Each write sends the whole list (settings merge top-level keys), so writes go
// out in order and only after a successful load. A refused write puts back the
// list the server holds and drops the writes queued behind it, which were built
// on the refused one.
const persist = (next) => {
  const gen = ++generation;
  publish(next);
  writeTail = writeTail.then(() => {
    if (gen <= refusedThrough) return;
    return updateSettings({ filmLookPresets: next }, { silent: true }).then(
      () => { confirmed = next; },
      (err) => {
        refusedThrough = generation;
        publish(confirmed);
        toast.error(`Could not save film look presets: ${err.message}`);
      },
    );
  });
  return writeTail;
};

const slug = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'look';

/**
 * The install's saved film looks (`settings.filmLookPresets`): `{ presets,
 * save(label, look), remove(id) }`. Saving under an existing name replaces that
 * look. `presets` is [] and `loaded` false until the list has been read; save
 * and remove do nothing before then, so a write never replaces looks it never saw.
 */
export default function useFilmLookPresets() {
  const [list, setList] = useState(presets);
  useEffect(() => {
    listeners.add(setList);
    if (presets) setList(presets);
    else load();
    return () => { listeners.delete(setList); };
  }, []);
  const save = useCallback((label, look) => {
    if (!presets) return null;
    const name = label.trim();
    const current = presets;
    const existing = current.find((preset) => preset.label.toLowerCase() === name.toLowerCase());
    const entry = { id: existing?.id || `${slug(name)}-${Date.now().toString(36)}`, label: name, look: { ...normalizeFilmLook(look), preset: 'custom' } };
    persist(existing ? current.map((preset) => (preset.id === existing.id ? entry : preset)) : [...current, entry]);
    return entry;
  }, []);
  const remove = useCallback((id) => { if (presets) persist(presets.filter((preset) => preset.id !== id)); }, []);
  return { presets: list ?? [], loaded: list !== null, save, remove };
}

/** Test-only: forget the cached list between suites. */
export function resetFilmLookPresetsCache() {
  presets = null;
  confirmed = null;
  loading = null;
  writeTail = Promise.resolve();
  generation = 0;
  refusedThrough = 0;
  listeners.clear();
}
