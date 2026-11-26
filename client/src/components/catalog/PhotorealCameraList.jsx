import { Check, Loader2 } from 'lucide-react';
import MediaImage from '../MediaImage';
import { PHOTOREAL_ROLE_PREFIX } from '../../lib/creativeLibraries';
import { photorealActionButton } from './photorealControls';

// The newest render per camera, plus older ones still kept (a plate in use).
const rendersByShot = (media) => {
  const map = new Map();
  for (const m of media || []) {
    if (m.deleted || m.kind !== 'reference' || !m.role?.startsWith(PHOTOREAL_ROLE_PREFIX)) continue;
    const shotId = m.role.slice(PHOTOREAL_ROLE_PREFIX.length);
    map.set(shotId, [...(map.get(shotId) || []), m].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
  }
  return map;
};

export default function PhotorealCameraList({ shots, chosen, media, readOnly, running, canSetPlate, platingShot, onToggle, onSetPlate }) {
  const renders = rendersByShot(media);

  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-label="Cameras">
      {shots.map((shot) => {
        const latest = renders.get(shot.id)?.[0] || null;
        const isPlate = latest && shot.plate === latest.mediaKey;
        const checked = chosen.includes(shot.id);
        return (
          <li key={shot.id} className="rounded-lg border border-port-border bg-port-card p-2 space-y-2">
            <label htmlFor={`photoreal-shot-${shot.id}`} className="flex items-center gap-2 text-sm text-gray-200 min-h-[32px]">
              <input id={`photoreal-shot-${shot.id}`} type="checkbox" checked={checked} disabled={running} onChange={() => onToggle(shot.id)} />
              <span className="truncate">{shot.label}</span>
              <span className="text-[11px] text-gray-500">{shot.aspect || '16:9'} · {shot.focalLengthMm || 35}mm</span>
            </label>
            {latest ? (
              <>
                <MediaImage src={`/data/images/${encodeURIComponent(latest.mediaKey)}`} loading="lazy" decoding="async" alt={latest.caption || shot.label}
                  className="w-full rounded bg-black object-contain" />
                <p className="text-[11px] text-gray-500 line-clamp-2">{latest.caption}</p>
                {!readOnly && (
                  <button type="button" className={photorealActionButton} disabled={!canSetPlate}
                    aria-pressed={!!isPlate} onClick={() => onSetPlate(shot, isPlate ? null : latest.mediaKey)}>
                    {platingShot === shot.id ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                    {isPlate ? 'Photo plate (tap to clear)' : 'Use as photo plate'}
                  </button>
                )}
              </>
            ) : (
              <p className="text-xs text-gray-500">Not rendered yet.</p>
            )}
          </li>
        );
    })}
  </ul>
  );
}
