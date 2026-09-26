import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import Drawer from '../Drawer';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { copyToClipboard } from '../../lib/clipboard';
import socket from '../../services/socket';
import { createAppLaunchVideo, getAppLaunchVideos } from '../../services/apiApps';
import { listPipelineMusicLibrary } from '../../services/apiPipeline';

const inputClass = 'w-full rounded border border-port-border bg-port-bg p-2 text-port-text';
const buttonClass = 'rounded bg-port-accent px-3 py-2 text-white disabled:opacity-50';

export default function LaunchVideoPanel({ app }) {
  const [search, setSearch] = useSearchParams();
  const open = search.get('launchVideo') === 'true';
  const [tone, setTone] = useState('default');
  const [direction, setDirection] = useState('');
  const [format, setFormat] = useState('landscape');
  const [duration, setDuration] = useState(20);
  const [music, setMusic] = useState(false);
  const [musicTrack, setMusicTrack] = useState('');
  const [tracks, setTracks] = useState([]);
  const [videos, setVideos] = useState([]);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState(false);
  const submitting = useRef(false);
  const setOpen = value => setSearch(prev => {
    const next = new URLSearchParams(prev);
    if (value) next.set('launchVideo', 'true'); else next.delete('launchVideo');
    return next;
  });

  useEffect(() => {
    let active = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      getAppLaunchVideos(app.id, { silent: true }).then(result => {
        if (active && request === generation) { setVideos(result.videos); setError(''); }
      }).catch(err => { if (active && request === generation) setError(err.message); });
    };
    const completed = event => { if (event.appId === app.id) load(); };
    socket.on('video-gen:completed', completed);
    socket.on('connect', load);
    load();
    return () => { active = false; socket.off('video-gen:completed', completed); socket.off('connect', load); };
  }, [app.id]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    listPipelineMusicLibrary({ silent: true }).then(result => {
      if (active) setTracks(result.tracks);
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [open]);

  const [submit, running] = useAsyncAction(async () => {
    if (submitting.current) return;
    submitting.current = true;
    await createAppLaunchVideo(app.id, {
      tone, direction, format, targetDurationSec: duration,
      ...(music ? { musicTrack } : {}),
    }, { silent: true }).then(() => setQueued(true)).finally(() => { submitting.current = false; });
  });

  return <section className="rounded-lg border border-port-border bg-port-card p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-semibold">Launch video</h2>
      <button type="button" className={buttonClass} onClick={() => { setQueued(false); setOpen(true); }}>
        {videos.length ? 'Make another launch video' : 'Make launch video'}
      </button>
    </div>
    <p className="text-sm text-port-text-muted">Plan a short video using recreated screens and fictional content. Nothing is uploaded or posted.</p>
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {videos[0] && <div className="space-y-2">
      <video controls preload="metadata" className="max-h-80 w-full" src={`/data/videos/${encodeURIComponent(videos[0].filename)}`} poster={`/data/video-thumbnails/${encodeURIComponent(videos[0].thumbnail)}`} aria-label="Latest launch video" />
      <p className="whitespace-pre-wrap">{videos[0].caption}</p>
      <button type="button" className="text-port-accent" onClick={() => copyToClipboard(videos[0].caption)}>Copy caption</button>
      <Link className="ml-4 text-port-accent" to="/media/history">Media History</Link>
    </div>}
    <Drawer open={open} onClose={() => setOpen(false)} title="Make launch video" size="sm">
      {queued ? <div className="space-y-3"><p>Launch video queued. Closing this drawer leaves the run active.</p><Link className="text-port-accent" to="/cos/agents">Open CoS agents to follow or cancel the run</Link></div> :
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); submit(); }}>
          <div><label htmlFor="launch-tone">Tone</label><select id="launch-tone" className={inputClass} value={tone} onChange={event => setTone(event.target.value)}>{['default', 'polished', 'deadpan', 'cinematic', 'parody'].map(value => <option key={value} value={value}>{value}</option>)}</select></div>
          <div><label htmlFor="launch-direction">Direction (optional)</label><textarea id="launch-direction" className={inputClass} maxLength={2000} value={direction} onChange={event => setDirection(event.target.value)} /></div>
          <div><label htmlFor="launch-format">Format</label><select id="launch-format" className={inputClass} value={format} onChange={event => setFormat(event.target.value)}>{['landscape', 'vertical', 'square'].map(value => <option key={value} value={value}>{value}</option>)}</select></div>
          <div><label htmlFor="launch-duration">Duration (15–25 seconds)</label><input id="launch-duration" type="number" min={15} max={25} step={1} required className={inputClass} value={duration} onChange={event => setDuration(event.target.value === '' ? '' : Number(event.target.value))} /></div>
          <div><label htmlFor="launch-music"><input id="launch-music" type="checkbox" checked={music} onChange={event => setMusic(event.target.checked)} /> Include music</label></div>
          {music && <div><label htmlFor="launch-track">Music-library track</label><select id="launch-track" required className={inputClass} value={musicTrack} onChange={event => setMusicTrack(event.target.value)}><option value="">Choose a track</option>{tracks.map(track => <option key={track.filename} value={track.filename}>{track.label}</option>)}</select>{!tracks.length && <p>Add a track to the Music library first.</p>}</div>}
          <p className="text-sm text-port-text-muted">These options are submitted together. Follow and cancel the run in CoS agents.</p>
          <button type="submit" className={buttonClass} disabled={running || duration === '' || (music && !musicTrack)}>{running ? 'Queuing…' : 'Queue launch video'}</button>
        </form>}
    </Drawer>
  </section>;
}
