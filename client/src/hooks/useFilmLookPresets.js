import { useCallback, useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../services/apiSystem.js';
import { normalizeFilmLook } from '../lib/filmLook.js';
import toast from '../components/ui/Toast';

// One copy per page: every Film look panel, shot picker and gallery editor reads
// the same list, so a look saved in one shows in the others at once and the
// settings are fetched once, not once per shot card.
let presets = null; // null = not loaded yet
let loading = null;
let writeTail = Promise.resolve();
const listeners = new Set();

const publish = (next) => {
  presets = next;
  listeners.forEach((listener) => listener(next));
};

const load = () => {
  loading ||= getSettings({ silent: true })
    .then((settings) => publish(Array.isArray(settings?.filmLookPresets) ? settings.filmLookPresets : []))
    .catch(() => { loading = null; publish(presets ?? []); });
  return loading;
};

// Writes go out in order, each with the whole list (settings merge top-level keys).
const persist = (next) => {
  const previous = presets;
  publish(next);
  writeTail = writeTail
    .then(() => updateSettings({ filmLookPresets: next }, { silent: true }))
    .catch((err) => {
      publish(previous ?? []);
      toast.error(`Could not save film look presets: ${err.message}`);
    });
  return writeTail;
};

const slug = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'look';

/**
 * The install's saved film looks (`settings.filmLookPresets`): `{ presets,
 * save(label, look), remove(id) }`. Saving under an existing name replaces that
 * look. `presets` is [] until loaded.
 */
export default function useFilmLookPresets() {
  const [list, setList] = useState(presets ?? []);
  useEffect(() => {
    listeners.add(setList);
    if (presets) setList(presets);
    else load();
    return () => { listeners.delete(setList); };
  }, []);
  const save = useCallback((label, look) => {
    const name = label.trim();
    const current = presets ?? [];
    const existing = current.find((preset) => preset.label.toLowerCase() === name.toLowerCase());
    const entry = { id: existing?.id || `${slug(name)}-${Date.now().toString(36)}`, label: name, look: { ...normalizeFilmLook(look), preset: 'custom' } };
    persist(existing ? current.map((preset) => (preset.id === existing.id ? entry : preset)) : [...current, entry]);
    return entry;
  }, []);
  const remove = useCallback((id) => persist((presets ?? []).filter((preset) => preset.id !== id)), []);
  return { presets: list, save, remove };
}

/** Test-only: forget the cached list between suites. */
export function resetFilmLookPresetsCache() {
  presets = null;
  loading = null;
  writeTail = Promise.resolve();
  listeners.clear();
}
