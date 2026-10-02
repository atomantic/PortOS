import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { saveMusicVideoSongRevision, actOnMusicVideoSongRevision, getMusicVideoProject } from '../../services/apiMusicVideo.js';
import { trackAudioUrl } from '../../services/apiTracks.js';
import socket from '../../services/socket';
import { formatCount } from '../../utils/formatters.js';

/** A saved draft never changes the current master. Only a listened-to candidate may replace it. */
export default function SongRevisionPanel({ project, tracks = [], onUpdated, onFork, disabled }) {
  const track = tracks.find((t) => t.id === project.trackId);
  const seed = project.songRevision?.fields || project.songRevisionHistory?.at(-1)?.fields;
  const [fields, setFields] = useState(() => seed || {
    title: (track?.title || project.name || '').slice(0, 80), style: track?.prompt || '',
    lyrics: track?.lyrics || (project.lyricCues || []).map((cue) => cue.text).join('\n'), instrumental: false,
  });
  const localEdited = useRef(false);
  const editFields = (next) => { localEdited.current = true; setFields(next); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [heard, setHeard] = useState({});
  const updateRef = useRef(onUpdated);
  const latestSequence = useRef(project.songRevision?.sequence || 0);
  latestSequence.current = Math.max(latestSequence.current, project.songRevision?.sequence || 0);
  updateRef.current = (next) => {
    if ((next.songRevision?.sequence || 0) < latestSequence.current) return;
    latestSequence.current = next.songRevision?.sequence || 0;
    if (!localEdited.current && next.songRevision?.fields) {
      setFields(next.songRevision.fields);
    }
    onUpdated(next);
    return next;
  };
  useEffect(() => {
    let active = true;
    let generation = 0;
    const receive = (event) => { if (active && event.projectId === project.id) { generation++; updateRef.current(event.project); } };
    const refresh = () => {
      const requested = ++generation;
      return getMusicVideoProject(project.id, { silent: true }).then((next) => {
        if (active && requested === generation && (next.songRevision?.sequence || 0) > latestSequence.current) updateRef.current(next);
      }).catch((err) => { if (active && requested === generation) setError(err.message); });
    };
    socket.on('music-video:song-revision', receive);
    socket.on('connect', refresh);
    refresh();
    return () => { active = false; socket.off('music-video:song-revision', receive); socket.off('connect', refresh); };
  }, [project.id]);
  const revision = project.songRevision;
  const dirty = JSON.stringify(fields) !== JSON.stringify(revision?.fields);
  const run = (request) => {
    setBusy(true); setError('');
    return request().then(({ project: next }) => updateRef.current(next))
      .catch((err) => setError(err.message)).finally(() => setBusy(false));
  };
  const action = (name, extra = {}) => run(() => actOnMusicVideoSongRevision(project.id, name, { revisionId: revision.id, ...extra }, { silent: true }));
  const settled = ['review', 'failed'].includes(revision?.status);
  const canDraft = !revision || ['draft', 'canceled', 'failed'].includes(revision.status);
  return <section aria-label="Song revision" className="min-w-0 space-y-3 rounded-lg border border-port-border bg-port-card p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">Revise lyrics & song</h3>
      <button type="button" disabled={busy || disabled} onClick={onFork} className="min-h-[44px] text-sm text-port-accent">Fork & revise song</button>
    </div>
    <p className="text-xs text-port-text-muted">Fork preserves this version and its video. Edit the fork’s song, generate Suno candidates, then listen and select new audio. Saving a draft uses no credits.</p>
    {project.parentProjectId && <p className="text-xs">Version {formatCount(project.version || 2)} · <Link className="text-port-accent" to={`/music-video/${project.parentProjectId}`}>Previous version</Link> · {formatCount(project.songRevisionHistory?.length || 0)} prior song revisions</p>}
    {project.parentProjectId && <>
      <fieldset disabled={busy || disabled || !canDraft} className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <div><label htmlFor="song-revision-title" className="block text-xs">Song title</label><input id="song-revision-title" value={fields.title} maxLength={80} onChange={(e) => editFields({ ...fields, title: e.target.value })} className="w-full rounded border border-port-border bg-port-bg p-2" /></div>
        <div><label htmlFor="song-revision-style" className="block text-xs">Suno musical style</label><textarea id="song-revision-style" value={fields.style} maxLength={1000} onChange={(e) => editFields({ ...fields, style: e.target.value })} className="w-full rounded border border-port-border bg-port-bg p-2" /></div>
        <div className="sm:col-span-2"><label htmlFor="song-revision-lyrics" className="block text-xs">Revision lyrics</label><textarea id="song-revision-lyrics" rows={6} value={fields.lyrics} maxLength={5000} onChange={(e) => editFields({ ...fields, lyrics: e.target.value })} className="w-full rounded border border-port-border bg-port-bg p-2" /></div>
        <label className="flex items-center gap-2 text-xs" htmlFor="song-revision-instrumental"><input id="song-revision-instrumental" type="checkbox" checked={fields.instrumental} onChange={(e) => editFields({ ...fields, instrumental: e.target.checked })} />Instrumental</label>
        <button type="button" disabled={!dirty || !fields.title.trim() || !fields.style.trim() || (!fields.instrumental && !fields.lyrics.trim())} onClick={() => run(() => saveMusicVideoSongRevision(project.id, fields, { silent: true })).then(next => { if (next) { localEdited.current = false; setFields(next.songRevision.fields); } })} className="min-h-[44px] text-sm text-port-accent">Save song draft</button>
      </fieldset>
      {revision && <>
        <p role="status" className="text-sm">Song revision: {revision.status}</p>
        {revision.error && <p role="alert" className="text-sm text-port-warning">{revision.error}. Downloads can resume using the same submitted songs. If no song IDs were returned, check Suno before creating another draft.</p>}
        <div className="flex flex-wrap gap-3">
          {['draft', 'failed', 'generating'].includes(revision.status) && <button type="button" disabled={busy || disabled || dirty} onClick={() => action('generate')} className="min-h-[44px] text-sm text-port-accent">{revision.submitted ? 'Resume candidate downloads' : 'Generate with Suno — uses credits'}</button>}
          {revision.status !== 'selected' && revision.status !== 'canceled' && <button type="button" disabled={busy} onClick={() => action('cancel')} className="min-h-[44px] text-sm">Cancel song revision</button>}
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          {(revision.candidates || []).map((candidate, index) => <div key={`${revision.id}:${candidate.songId}`} className="min-w-0 space-y-2 rounded border border-port-border p-2">
            <a href={`https://suno.com/song/${encodeURIComponent(candidate.songId)}`} target="_blank" rel="noreferrer" className="text-sm text-port-accent">Suno candidate {formatCount(index + 1)}</a>
            <audio controls preload="none" src={trackAudioUrl(candidate.filename)} aria-label={`Listen to candidate ${index + 1}`} onPlay={() => setHeard((old) => ({ ...old, [`${revision.id}:${candidate.songId}`]: true }))} className="w-full" />
            <button type="button" disabled={busy || disabled || !settled || !heard[`${revision.id}:${candidate.songId}`]} onClick={() => action('select', { songId: candidate.songId })} className="min-h-[44px] text-sm text-port-accent">Use candidate {formatCount(index + 1)}</button>
          </div>)}
        </div>
        {revision.status === 'selected' && <div className="space-y-2 text-sm" role="status">
          <p>New master selected. Art and editable composition source are retained. Beat analysis, lyric alignment, shot timing, proofs and renders need fresh review.</p>
          <ol className="list-inside list-decimal space-y-1">
            <li>Analyze the new song and align its lyrics below; verify by listening.</li>
            <li><Link className="text-port-accent" to={`/music-video/${project.id}/board`}>Review shot timing and retained or revised art on the Board.</Link></li>
            <li><Link className="text-port-accent" to={`/music-video/${project.id}/compose`}>Regenerate or reimport the composition against the new audio.</Link> Imported source can contain a fuller timeline than the Board; revise that source too.</li>
            <li><Link className="text-port-accent" to={`/music-video/${project.id}/review`}>Rebuild and review proofs before the full video.</Link></li>
          </ol>
        </div>}
      </>}
    </>}
    {!!project.songRevisionHistory?.length && <details>
      <summary className="cursor-pointer py-2 text-sm">Previous song revision provenance</summary>
      <ul className="space-y-2 text-xs">{project.songRevisionHistory.map(previous => <li key={previous.id} className="rounded border border-port-border p-2">
        <p>{previous.fields?.title} · {previous.status}</p>
        <p className="whitespace-pre-wrap">{previous.fields?.style}</p>
        {previous.selectedSongId && <a className="text-port-accent" href={`https://suno.com/song/${encodeURIComponent(previous.selectedSongId)}`} target="_blank" rel="noreferrer">Selected Suno source</a>}
      </li>)}</ul>
    </details>}
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
  </section>;
}
