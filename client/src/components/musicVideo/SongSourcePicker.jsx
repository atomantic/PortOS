import ToggleChip from '../ui/ToggleChip.jsx';
import { AUTONOMOUS_SONG_SOURCES, AUTONOMOUS_SONG_SOURCE_LABELS } from '../../lib/musicVideoAutonomous.js';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * Where an autonomous run's song comes from — Suno through the PortOS Browser or
 * a local Music Studio engine — plus the Suno-only opt-in to render locally when
 * Suno cannot take the request. Shared by the start drawer and the autopilot
 * Schedule form; `onChange` receives a partial draft patch.
 */
export default function SongSourcePicker({ idPrefix, songSource, localFallback, onChange }) {
  return (
    <div>
      <label htmlFor={`${idPrefix}-song-source`} className="block text-xs text-port-text-muted mb-1">Song source</label>
      <select
        id={`${idPrefix}-song-source`}
        value={songSource}
        onChange={(e) => onChange({ songSource: e.target.value })}
        className={inputClass}
      >
        {AUTONOMOUS_SONG_SOURCES.map((source) => (
          <option key={source} value={source}>{AUTONOMOUS_SONG_SOURCE_LABELS[source]}</option>
        ))}
      </select>
      <p className="text-[11px] text-port-text-muted mt-1">
        {songSource === 'suno'
          ? 'Suno is driven through the PortOS Browser — sign in to Suno there first. It spends Suno credits.'
          : 'Rendered on this machine by a ready Music Studio engine (a lyric-capable one such as ACE-Step for vocals). Free, but it queues behind other GPU work.'}
      </p>
      {songSource === 'suno' && (
        <div className="mt-2">
          <ToggleChip
            id={`${idPrefix}-local-fallback`}
            label="Render locally if Suno is unavailable"
            checked={localFallback}
            onToggle={() => onChange({ localFallback: !localFallback })}
          />
        </div>
      )}
    </div>
  );
}
