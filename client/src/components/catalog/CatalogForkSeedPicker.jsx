import { Check } from 'lucide-react';
import MediaImage from '../MediaImage';
import { imageThumbnailSrc } from '../../lib/imageThumbnailSrc';

const formLabel = (form) => [form.label || 'Age', Number.isInteger(form.age) ? `${form.age}` : ''].filter(Boolean).join(' · ');

// Tap the source's references to seed a fork. Grouped by age so a v2 can start
// from a few canonical images per age; nothing is picked until tapped.
export default function CatalogForkSeedPicker({ candidates, forms = [], selected, onChange, disabled = false, loading = false, error = '', onRetry }) {
  // One tile per file. A set-primary portrait row is often untagged beside the
  // age-tagged reference row of the same file, so the tagged row wins.
  const byKey = new Map();
  for (const m of candidates || []) {
    const prior = byKey.get(m.mediaKey);
    if (!prior || (!prior.library?.variant?.formId && m.library?.variant?.formId)) byKey.set(m.mediaKey, m);
  }
  const images = [...byKey.values()];
  const known = new Set(forms.map((form) => form.id));
  const groups = [{ id: '', label: 'Canonical' }, ...forms.map((form) => ({ id: form.id, label: formLabel(form) }))]
    .map((group) => ({ ...group, items: images.filter((m) => {
      const formId = m.library?.variant?.formId;
      return group.id ? formId === group.id : !formId || !known.has(formId);
    }) }))
    .filter((group) => group.items.length);
  const toggle = (keys, on) => {
    const next = new Set(selected);
    for (const key of keys) { if (on) next.add(key); else next.delete(key); }
    onChange(next);
  };
  return (
    <fieldset className="space-y-2 min-w-0" disabled={disabled}>
      <legend className="text-xs text-gray-400">Seed images for the fork <span className="text-gray-500">· {selected.size} picked</span></legend>
      {error ? <p role="alert" className="text-xs text-port-error">Could not load images. <button type="button" onClick={onRetry} className="underline">Retry</button></p>
        : loading ? <p className="text-xs text-gray-400">Loading images…</p>
          : !groups.length ? <p className="text-xs text-gray-500">No reference images to seed from. The fork starts with text only.</p>
            : groups.map((group) => {
              const keys = group.items.map((m) => m.mediaKey);
              const all = keys.every((key) => selected.has(key));
              return (
                <div key={group.id || 'canonical'} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-gray-300">{group.label}</span>
                    <button type="button" onClick={() => toggle(keys, !all)} className="min-h-9 px-2 text-xs text-port-accent hover:underline">{all ? 'Clear' : 'Pick all'}</button>
                  </div>
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
                    {group.items.map((m) => {
                      const on = selected.has(m.mediaKey);
                      const src = `/data/images/${encodeURIComponent(m.mediaKey)}`;
                      return (
                        <button key={m.mediaKey} type="button" aria-pressed={on} aria-label={`Seed ${m.caption || m.mediaKey} (${group.label})`}
                          onClick={() => toggle([m.mediaKey], !on)}
                          className={`relative rounded overflow-hidden border-2 ${on ? 'border-port-accent' : 'border-transparent opacity-70'}`}>
                          <MediaImage src={imageThumbnailSrc(src) || src} fallbackSrc={[src, `/data/image-refs/${encodeURIComponent(m.mediaKey)}`]}
                            alt="" className="w-full aspect-square object-cover" loading="lazy" />
                          {on && <span className="absolute top-1 right-1 rounded-full bg-port-accent p-0.5 text-white"><Check size={12} aria-hidden="true" /></span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
      <p className="text-xs text-gray-500">Picked images keep their age on the fork and share the same files. Sheets, plates and looks are not copied; the fork renders its own.</p>
    </fieldset>
  );
}
