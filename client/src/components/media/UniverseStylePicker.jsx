import { useEffect, useId, useMemo, useState } from 'react';
import { Globe, X } from 'lucide-react';
import { listUniverseStyles } from '../../services/api';
import { universeStylePreset } from '../../lib/universeStylePreset';

// Universe style is intentionally a separate picker from StylePresetPicker:
// the former reads the user's saved embrace/avoid influences, while the latter
// reads the shipped image-style catalog. Both can be layered onto one render.
export default function UniverseStylePicker({
  value,
  onChange,
  disabled = false,
  className = '',
  label = 'Universe style',
}) {
  const [styles, setStyles] = useState([]);
  const selectId = useId();

  useEffect(() => {
    let cancelled = false;
    listUniverseStyles({ silent: true }).then((rows) => {
      if (cancelled) return;
      setStyles(Array.isArray(rows) ? rows : []);
    }).catch(() => { /* unavailable styles leave the picker hidden */ });
    return () => { cancelled = true; };
  }, []);

  const activeUniverse = useMemo(
    () => (value ? styles.find((universe) => universe.id === value) : null),
    [value, styles],
  );
  const activePreset = useMemo(
    () => (activeUniverse ? universeStylePreset(activeUniverse) : null),
    [activeUniverse],
  );

  const handleChange = (event) => {
    const id = event.target.value;
    onChange?.(id ? styles.find((universe) => universe.id === id) || null : null);
  };

  // Universes with no style influences are omitted by the endpoint, so an
  // empty result should not add an inert control to the media form.
  if (styles.length === 0) return null;

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={selectId} className="text-xs font-medium text-gray-400 flex items-center gap-1">
          <Globe className="w-3 h-3" /> {label}
        </label>
        {value && (
          <button
            type="button"
            onClick={() => onChange?.(null)}
            disabled={disabled}
            className="text-[10px] text-gray-500 hover:text-port-error flex items-center gap-0.5 disabled:opacity-50"
            title="Clear universe style"
          >
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>
      <select
        id={selectId}
        value={value || ''}
        onChange={handleChange}
        disabled={disabled}
        className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
      >
        <option value="">None — use prompt as-is</option>
        {styles.map((universe) => (
          <option key={universe.id} value={universe.id}>{universe.name}</option>
        ))}
      </select>
      {activePreset?.prompt && (
        <p className="mt-1 text-[10px] text-port-success/80 truncate" title={activePreset.prompt}>
          Positive: {activePreset.prompt}
        </p>
      )}
      {activePreset?.negativePrompt && (
        <p className="text-[10px] text-port-error/80 truncate" title={activePreset.negativePrompt}>
          Negative: {activePreset.negativePrompt}
        </p>
      )}
    </div>
  );
}
