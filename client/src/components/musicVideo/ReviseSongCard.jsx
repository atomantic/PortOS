import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Check, RefreshCw } from 'lucide-react';
import socket from '../../services/socket';
import { reviseMusicVideoSongFromTrack, actOnMusicVideoSongRevisionScenes } from '../../services/apiMusicVideo.js';
import useYoutubeTrackImport from '../../hooks/useYoutubeTrackImport.js';
import { formatCount } from '../../utils/formatters.js';
import { trackOptionLabels } from '../../utils/trackOptionLabels.js';

const buttonClass = 'min-h-[44px] rounded border border-port-border bg-port-bg px-3 py-1.5 text-sm disabled:opacity-50 sm:min-h-0';
const primaryClass = 'min-h-[44px] rounded bg-port-accent px-3 py-1.5 text-sm text-white disabled:opacity-50 sm:min-h-0';

const countLine = (parts) => parts.filter(([n]) => n > 0).map(([n, label]) => `${formatCount(n)} ${label}`).join(' · ');

/** The lines the new song kept, reworded, added and cut. */
function LyricChanges({ project, revision }) {
  const status = revision.cueStatus || {};
  const cues = project.lyricCues || [];
  const changed = cues.filter((c) => status[c.id] === 'changed');
  const added = cues.filter((c) => status[c.id] === 'added');
  const removed = revision.removedLines || [];
  if (!changed.length && !added.length && !removed.length) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer py-2">What changed in the lyrics</summary>
      <ul className="space-y-1">
        {changed.map((c) => <li key={c.id} className="break-words"><span className="text-port-text-muted line-through">{revision.changedFrom?.[c.id]}</span> → {c.text}</li>)}
        {added.map((c) => <li key={c.id} className="break-words text-port-success">+ {c.text}</li>)}
        {removed.map((c) => <li key={c.id} className="break-words text-port-error">− {c.text}</li>)}
      </ul>
    </details>
  );
}

/**
 * Revise the song mid-project, top of the Song step. Paste the new Suno link
 * (or pick a library track): a new version gets the song and this one stays
 * as it is. The new version re-times on its own (analysis, the separated
 * vocal, lyric alignment), moves every shot through the lines both songs
 * share, and flags the shots the new lyrics changed, added or cut.
 */
export default function ReviseSongCard({ project, tracks = [], disabled = false, retime = null, onRevised, onRetime, onUpdated, onTrackImported }) {
  const revision = project.songRevision?.status === 'selected' && project.songRevision.baseline ? project.songRevision : null;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  sequence.current = Math.max(sequence.current, project.songRevision?.sequence || 0);
  const updated = useRef(onUpdated);
  updated.current = onUpdated;

  // Re-time progress and its result arrive as song-revision events.
  useEffect(() => {
    const receive = (event) => {
      if (event.projectId !== project.id || (event.project?.songRevision?.sequence || 0) <= sequence.current) return;
      sequence.current = event.project.songRevision.sequence;
      updated.current?.(event.project);
    };
    socket.on('music-video:song-revision', receive);
    return () => socket.off('music-video:song-revision', receive);
  }, [project.id]);

  const run = (request) => {
    setBusy(true); setError('');
    return request().catch((err) => setError(err?.message || 'That did not work. Try again.')).finally(() => setBusy(false));
  };
  const revise = (trackId) => run(() => reviseMusicVideoSongFromTrack(project.id, trackId, { silent: true }).then((result) => {
    setOpen(false); setUrl('');
    onRevised?.(result);
  }));
  const importJob = useYoutubeTrackImport({
    onComplete: (track) => {
      onTrackImported?.(track);
      revise(track.id);
    },
  });
  const act = (action) => run(() => actOnMusicVideoSongRevisionScenes(project.id, { revisionId: revision.id, action }, { silent: true })
    .then(({ project: next }) => onUpdated?.(next)));

  const working = busy || importJob.active;
  const picker = (
    <div className="space-y-2">
      <p className="text-xs text-port-text-muted">A new version gets the new song and keeps your shots; this version stays as it is.</p>
      <div className="flex flex-wrap gap-2">
        <label htmlFor={`mv-revise-song-url-${project.id}`} className="sr-only">New song link</label>
        <input id={`mv-revise-song-url-${project.id}`} type="url" value={url} onChange={(e) => setUrl(e.target.value)} disabled={working || disabled}
          onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) { e.preventDefault(); importJob.start(url); } }}
          placeholder="Paste the new Suno link…" className="min-h-[44px] min-w-0 flex-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm sm:min-h-0" />
        {importJob.active
          ? <button type="button" onClick={importJob.cancel} className={buttonClass}>Importing {formatCount(importJob.percent, { fallback: '0' })}% · Cancel</button>
          : <button type="button" onClick={() => importJob.start(url)} disabled={!url.trim() || working || disabled} className={primaryClass}>Use this song</button>}
      </div>
      <label htmlFor={`mv-revise-song-track-${project.id}`} className="block text-xs text-port-text-muted">Or a song already in the library</label>
      <select id={`mv-revise-song-track-${project.id}`} value="" disabled={working || disabled} onChange={(e) => e.target.value && revise(e.target.value)}
        className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1 text-sm sm:min-h-0">
        <option value="">Pick a track…</option>
        {(() => {
          const labels = trackOptionLabels(tracks);
          return tracks.filter((t) => t.id !== project.trackId).map((t) => <option key={t.id} value={t.id}>{labels.get(t.id)}</option>);
        })()}
      </select>
    </div>
  );

  if (!revision) {
    return (
      <section aria-label="Revise song" className="min-w-0 space-y-2 rounded-lg border border-port-border p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Changed the song?</h3>
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={disabled}
            className={`${buttonClass} flex items-center gap-1 text-port-accent`}><RefreshCw size={14} aria-hidden="true" /> Revise song</button>
        </div>
        {open && picker}
        {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      </section>
    );
  }

  const review = revision.sceneReview || {};
  const pending = (statuses) => Object.values(review).filter((entry) => statuses.includes(entry.status) && !entry.resolved).length;
  const toReplan = pending(['changed', 'new']);
  const toRemove = pending(['removed']);
  const counts = revision.sceneCounts;
  const lyrics = revision.lyricDiff || {};
  // A stored 'running' with no live job slot is a job this page lost (a restart): offer the button again.
  const stored = revision.retime?.status || 'pending';
  // `retime` is the page's alignment slot, which a plain Align words run also fills.
  const state = stored === 'done' ? 'done' : retime ? 'running' : stored === 'running' ? 'pending' : stored;
  return (
    <section aria-label="Revised song" className="min-w-0 space-y-2 rounded-lg border border-port-accent/50 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Revised song{revision.fields?.title ? `: ${revision.fields.title}` : ''}</h3>
        {project.parentProjectId && <Link to={`/music-video/${encodeURIComponent(project.parentProjectId)}/setup`} className="text-xs text-port-accent">Previous version</Link>}
      </div>
      <p className="text-xs">Lyrics: {countLine([[lyrics.kept, 'kept'], [lyrics.changed, 'reworded'], [lyrics.added, 'new'], [lyrics.removed, 'cut']]) || 'no lines'}</p>
      <LyricChanges project={project} revision={revision} />

      {state === 'running' && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-port-text-muted">
          <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
          <span>{retime?.label || 'Re-timing to the new song…'}{retime?.percent > 0 ? ` ${formatCount(retime.percent)}%` : ''}</span>
          {retime?.onCancel && <button type="button" onClick={retime.onCancel} className={`${buttonClass} text-port-error`}>Cancel</button>}
        </div>
      )}
      {state !== 'running' && state !== 'done' && (
        <div className="space-y-1">
          {state === 'failed' && <p role="alert" className="text-xs text-port-error">{revision.retime?.error || 'Re-timing failed.'} Fix the lyrics below if they differ from the vocal, then try again.</p>}
          <button type="button" onClick={onRetime} disabled={disabled || working} className={primaryClass}>{state === 'failed' ? 'Try re-timing again' : 'Re-time lyrics and shots'}</button>
          <p className="text-xs text-port-text-muted">Analyzes the new song, separates its vocal, aligns the lyrics and moves the shots.</p>
        </div>
      )}
      {state === 'done' && counts && (
        <div className="space-y-2">
          <p className="flex items-center gap-1 text-xs text-port-success"><Check size={14} aria-hidden="true" /> Shots moved to the new song: {countLine([[counts.kept, 'kept'], [counts.changed, 'changed'], [counts.new, 'new'], [counts.removed, 'cut']]) || 'none'}</p>
          {(toReplan > 0 || toRemove > 0) && (
            <div className="flex flex-wrap gap-2">
              {toReplan > 0 && <button type="button" onClick={() => act('replan')} disabled={disabled || working} className={primaryClass}>{busy ? 'Working…' : `Replan ${formatCount(toReplan)} shot${toReplan === 1 ? '' : 's'}`}</button>}
              {toRemove > 0 && <button type="button" onClick={() => act('remove')} disabled={disabled || working} className={buttonClass}>Remove {formatCount(toRemove)} cut shot{toRemove === 1 ? '' : 's'}</button>}
              <Link to={`/music-video/${encodeURIComponent(project.id)}/board?scenes=attention`} className={`${buttonClass} text-port-accent`}>Review on Storyboard</Link>
              <button type="button" onClick={() => act('dismiss')} disabled={disabled || working} className={buttonClass}>Keep them as they are</button>
            </div>
          )}
          {toReplan > 0 && <p className="text-xs text-port-text-muted">Replan writes new frame and motion prompts for the changed and new shots with the planning model.</p>}
          {revision.compositionStale && (
            <p className="text-xs text-port-warning">The composition document still has the old song&rsquo;s timing and lyrics. <Link to={`/music-video/${encodeURIComponent(project.id)}/produce#mv-composition`} className="text-port-accent">Regenerate or reimport it</Link>.</p>
          )}
          {toReplan === 0 && toRemove === 0 && (
            <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
              <summary className="cursor-pointer py-2 text-xs text-port-accent">Revise the song again</summary>
              {picker}
            </details>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
    </section>
  );
}
