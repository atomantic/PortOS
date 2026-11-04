import { useState } from 'react';
import { Clapperboard, Loader2, Pin, PinOff } from 'lucide-react';
import CatalogMediaTile from './CatalogMediaTile';

// The Plates tab for an environment: set plates are reference images whose
// catalog media role is `plate`. Marking/unmarking re-attaches the same media
// key with a new role (the attach endpoint upserts role on the existing row),
// via `onSetRole(media, role)` which resolves true on success.
export default function CatalogPlatesPanel({ plates, candidates, missingMedia, onSetRole, onDetach }) {
  const [armedDetach, setArmedDetach] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const plateList = Array.isArray(plates) ? plates : [];
  const candidateList = Array.isArray(candidates) ? candidates : [];

  const setRole = async (m, role) => {
    if (busyKey || !onSetRole || m.readOnly) return;
    setBusyKey(m.mediaKey);
    await onSetRole(m, role);
    setBusyKey(null);
  };

  const roleButton = (m, role, label, Icon) => (
    <button type="button" onClick={() => setRole(m, role)} disabled={!!busyKey || !onSetRole || m.readOnly}
      title={label} aria-label={label}
      className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 port-media-overlay-item p-2 sm:p-1 rounded hover:text-port-accent disabled:opacity-50">
      {busyKey === m.mediaKey
        ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        : <Icon size={12} aria-hidden="true" />}
    </button>
  );

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white flex items-center gap-1.5 mb-3">
          <Clapperboard size={14} aria-hidden="true" /> Set plates
        </h2>
        {plateList.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {plateList.map((m) => (
              <CatalogMediaTile key={`${m.mediaKey}:${m.kind}`} m={m} missing={missingMedia?.has?.(m.mediaKey)}
                onDetach={onDetach} armedDetach={armedDetach} onArmDetach={setArmedDetach}
                extraActions={roleButton(m, null, 'Unmark plate', PinOff)} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-500">No plates yet. Mark a reference image below as a plate.</p>
        )}
      </div>
      <div>
        <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Mark a reference image as a plate</h3>
        {candidateList.length > 0 ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
            {candidateList.map((m) => (
              <CatalogMediaTile key={`${m.mediaKey}:${m.kind}`} m={m} missing={missingMedia?.has?.(m.mediaKey)}
                extraActions={roleButton(m, 'plate', 'Mark as plate', Pin)} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-500">No reference images to mark. Attach or generate some on the References tab.</p>
        )}
      </div>
    </section>
  );
}
