import { listMusicVideoProjectSummaries } from '../../services/apiMusicVideo.js';
import useListResource from '../../hooks/useListResource.js';
import ListLoadError from '../ui/ListLoadError.jsx';

const fetchSongProjects = () => listMusicVideoProjectSummaries({ limit: 500 }, { silent: true })
  .then((page) => (page?.items || []).filter((p) => p.trackId || p.uploadedAudioFilename));

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * Start an autonomous run on another project's song instead of making one: the
 * server copies its audio, analysis and timed lyrics, never its look. Lists the
 * projects that have a song, newest first.
 */
export default function ExistingSongSelect({ id, value, onChange }) {
  const { items: projects, state, error, retry } = useListResource(fetchSongProjects);
  const missing = value && state === 'ready' && !projects.some((p) => p.id === value);

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs text-port-text-muted mb-1">Song to use</label>
      <select id={id} value={value || ''} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">{state === 'loading' ? 'Loading…' : 'Make a new song'}</option>
        {missing && <option value={value}>{value} (not found)</option>}
        {projects.map((p) => <option key={p.id} value={p.id}>Use the song from {p.name}</option>)}
      </select>
      {state === 'error' && <ListLoadError what="projects with a song" error={error} onRetry={retry} className="mt-1" />}
      {value && (
        <p className="text-[11px] text-port-text-muted mt-1">
          Its audio, lyrics and word timing are copied. No lyrics are written and no song is made; the look starts fresh.
        </p>
      )}
    </div>
  );
}
