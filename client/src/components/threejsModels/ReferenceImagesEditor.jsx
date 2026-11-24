// Extra gallery views (back, close-ups, …) sent beside the primary image.
// The server owns the limit and the role list; `onChange` receives the whole
// [{filename, role, label}] array so callers can send it verbatim.
import { useEffect, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import MediaImage from '../MediaImage';
import { getThreejsProductSheet } from '../../services/apiThreejsModels.js';

export const REFERENCE_ROLES = ['front', 'side', 'back', 'top', 'turnaround-sheet', 'close-up'];
export const MAX_REFERENCE_IMAGES = 5;

// `primaryFilename` is the model's primary gallery image; when it belongs to a
// Casting object with a product sheet, a one-tap button offers that sheet.
export default function ReferenceImagesEditor({ value, onChange, disabled = false, primaryFilename = '' }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [productSheet, setProductSheet] = useState(null);

  useEffect(() => {
    setProductSheet(null);
    if (!primaryFilename) return undefined;
    let cancelled = false;
    // Optional affordance: a failed lookup just means no button.
    getThreejsProductSheet(primaryFilename, { silent: true })
      .then((result) => { if (!cancelled) setProductSheet(result?.sheet || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [primaryFilename]);

  const sheetAdded = productSheet && value.some((ref) => ref.filename === productSheet);
  const atCap = value.length >= MAX_REFERENCE_IMAGES;
  const patch = (index, change) => onChange(value.map((ref, i) => (i === index ? { ...ref, ...change } : ref)));

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-gray-400">
          Extra views <span className="text-gray-600">(optional, up to {MAX_REFERENCE_IMAGES})</span>
        </span>
        <button
          type="button"
          disabled={disabled || value.length >= MAX_REFERENCE_IMAGES}
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ImagePlus className="h-3.5 w-3.5" /> Add view
        </button>
      </div>
      {productSheet && !sheetAdded && (
        <button
          type="button"
          disabled={disabled || atCap}
          onClick={() => onChange([...value, { filename: productSheet, role: 'turnaround-sheet', label: '' }])}
          className="mb-2 inline-flex items-center gap-1 text-xs text-port-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11"
        >
          <ImagePlus className="h-3.5 w-3.5" /> Add product sheet
        </button>
      )}
      {value.length > 0 && (
        <ul className="space-y-2">
          {value.map((ref, index) => (
            <li key={`${ref.filename}-${index}`} className="flex items-center gap-2 rounded-lg border border-port-border bg-port-bg p-2">
              <MediaImage
                src={`/data/images/${encodeURIComponent(ref.filename)}`}
                alt={`Reference ${index + 1}`}
                className="h-12 w-12 shrink-0 rounded object-cover"
              />
              <select
                aria-label={`Role of reference ${index + 1}`}
                value={ref.role}
                disabled={disabled}
                onChange={(event) => patch(index, { role: event.target.value })}
                className="rounded border border-port-border bg-port-card px-2 py-1 text-xs text-white"
              >
                {REFERENCE_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              {ref.role === 'close-up' && (
                <input
                  aria-label={`What reference ${index + 1} shows`}
                  value={ref.label}
                  maxLength={120}
                  disabled={disabled}
                  onChange={(event) => patch(index, { label: event.target.value })}
                  placeholder="What this shows"
                  className="min-w-0 flex-1 rounded border border-port-border bg-port-card px-2 py-1 text-xs text-white placeholder:text-gray-600"
                />
              )}
              <button
                type="button"
                aria-label={`Remove reference ${index + 1}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="ml-auto shrink-0 text-gray-500 hover:text-port-error disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <GalleryImagePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(item) => onChange([...value, { filename: item.filename, role: 'back', label: '' }])}
      />
    </div>
  );
}
