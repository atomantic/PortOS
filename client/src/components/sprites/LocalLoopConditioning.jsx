import { useState } from 'react';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage.js';
import { spriteAssetUrl } from './spriteAssets.js';

// Scope drafts to the record, track and facing. A saved run supplies the
// reload default when this browser has no draft; legacy runs default off.
export function useLoopConditioning(recordId, track) {
  const [drafts, setDrafts] = useState({});
  const keyFor = (direction) => `sprite-idle-anchor:${recordId}:${track}:${direction}`;
  return {
    selected: (direction, run) => {
      const key = keyFor(direction);
      const saved = safeReadStorage(key);
      return drafts[key] ?? (saved === 'true' ? true : saved === 'false' ? false : run?.returnToIdleAnchor === true);
    },
    change: (direction, enabled) => {
      const key = keyFor(direction);
      setDrafts((previous) => ({ ...previous, [key]: enabled }));
      safeWriteStorage(key, String(enabled));
    },
  };
}

export default function LocalLoopConditioning({
  recordId, direction, anchor, enabled, onChange, disabled, supported,
}) {
  return (
    <div className="space-y-1 text-[11px] text-gray-400">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={`Return to idle anchor ${direction}`}
          checked={enabled}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled || (!supported && !enabled)}
        />
        Return to idle anchor
      </label>
      {!supported && <p role="status">This local model does not support both endpoints.</p>}
      <div className="flex gap-2">
        {(enabled ? ['First', 'Last'] : ['First']).map((position) => (
          <figure key={position} className="min-w-0 flex-1">
            {anchor?.path && (
              <img
                className="h-12 w-full object-contain"
                src={spriteAssetUrl(recordId, anchor.path, anchor.sha256)}
                alt={`${direction} ${position.toLowerCase()} conditioning anchor`}
              />
            )}
            <figcaption>{position}: idle anchor</figcaption>
          </figure>
        ))}
      </div>
      {enabled && <p>Both inputs use the same canvas and chroma preparation. Interior motion still requires review.</p>}
    </div>
  );
}
