import { useState } from 'react';
import { Waves } from 'lucide-react';
import toast from '../ui/Toast';
import { updateMusicVideoProject } from '../../services/apiMusicVideo.js';
import { trackOptionLabels } from '../../utils/trackOptionLabels.js';

const DEFAULT_VOLUME = 0.3;

/**
 * Optional sound-design bed (#8988). The song is the video's sole audio by
 * default; a director may explicitly pick one library track (ambience,
 * risers, texture) to mix UNDER it at a chosen level. The render trims the bed
 * to the song, so it can never extend or replace the master. "None" returns
 * the soundtrack to the song alone.
 */
export default function SoundBedControl({ project, tracks, disabled, onUpdated }) {
  const [busy, setBusy] = useState(false);
  const bed = project.soundBed || null;
  const [volume, setVolume] = useState(bed?.volume ?? DEFAULT_VOLUME);
  const selectId = `mv-sound-bed-${project.id}`;
  const volumeId = `mv-sound-bed-volume-${project.id}`;
  const candidates = tracks.filter((t) => t.id !== project.trackId);
  const optionLabels = trackOptionLabels(tracks);

  const save = (soundBed) => {
    setBusy(true);
    updateMusicVideoProject(project.id, { soundBed }, { silent: true })
      .then((updated) => {
        onUpdated(updated);
        toast.success(soundBed ? 'Sound-design bed set — mixed under the song' : 'Sound-design bed removed — the song is the only audio');
      })
      .catch((err) => toast.error(err?.message || 'Failed to update the sound-design bed'))
      .finally(() => setBusy(false));
  };

  // Save the level once the slider is released, not on every step of a drag.
  const commitVolume = () => {
    if (bed && volume !== bed.volume) save({ trackId: bed.trackId, volume });
  };
  const off = busy || disabled;
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
      <div>
        <label htmlFor={selectId} className="text-[10px] text-port-text-muted flex items-center gap-1"><Waves size={11} /> Sound-design bed</label>
        <select id={selectId} value={bed?.trackId || ''} disabled={off}
          onChange={(e) => save(e.target.value ? { trackId: e.target.value, volume } : null)}
          className="bg-port-bg border border-port-border rounded px-1.5 py-1 disabled:opacity-50 max-w-[16rem] min-h-[44px] sm:min-h-0">
          <option value="">None — the song is the only audio</option>
          {candidates.map((t) => <option key={t.id} value={t.id}>{optionLabels.get(t.id)}</option>)}
        </select>
      </div>
      {bed && (
        <div>
          <label htmlFor={volumeId} className="block text-[10px] text-port-text-muted">Bed level ({Math.round(volume * 100)}%)</label>
          <input id={volumeId} type="range" min={0.05} max={1} step={0.05} value={volume} disabled={off}
            onChange={(e) => setVolume(Number(e.target.value))}
            onPointerUp={commitVolume} onKeyUp={commitVolume}
            className="w-32" />
        </div>
      )}
    </div>
  );
}
