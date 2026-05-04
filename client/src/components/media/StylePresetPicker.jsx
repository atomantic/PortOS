import { useEffect, useMemo, useState } from 'react';
import { Palette, X } from 'lucide-react';
import { listImageStylePresets } from '../../services/apiSystem';

export default function StylePresetPicker({
  value,
  onChange,
  disabled = false,
  className = '',
  label = 'Style preset',
}) {
  const [presets, setPresets] = useState([]);

  useEffect(() => {
    let cancelled = false;
    listImageStylePresets().then((list) => {
      if (cancelled) return;
      setPresets(Array.isArray(list) ? list : []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const p of presets) {
      const cat = p.category || 'Other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(p);
    }
    return Array.from(map.entries());
  }, [presets]);

  const activePreset = useMemo(
    () => (value ? presets.find((p) => p.id === value) : null),
    [value, presets],
  );

  const handleChange = (e) => {
    const id = e.target.value;
    if (!id) { onChange?.(null); return; }
    const preset = presets.find((p) => p.id === id);
    if (preset) onChange?.(preset);
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-gray-400 flex items-center gap-1">
          <Palette className="w-3 h-3" /> {label}
        </label>
        {value && (
          <button
            type="button"
            onClick={() => onChange?.(null)}
            disabled={disabled}
            className="text-[10px] text-gray-500 hover:text-port-error flex items-center gap-0.5 disabled:opacity-50"
            title="Clear style preset"
          >
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>
      <select
        value={value || ''}
        onChange={handleChange}
        disabled={disabled || presets.length === 0}
        className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
      >
        <option value="">None — use prompt as-is</option>
        {grouped.map(([cat, items]) => (
          <optgroup key={cat} label={cat}>
            {items.map((p) => (
              <option key={p.id} value={p.id} title={p.description || ''}>
                {p.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {activePreset?.description && (
        <p className="mt-1 text-[10px] text-gray-500 truncate" title={activePreset.description}>
          {activePreset.description}
        </p>
      )}
    </div>
  );
}
