import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Download } from 'lucide-react';
import Drawer from '../Drawer';
import ProviderModelSelector from '../ProviderModelSelector';
import useRunWithPicker from '../../hooks/useRunWithPicker';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import useUrlParams from '../../hooks/useUrlParams';
import { copyToClipboard } from '../../lib/clipboard';
import socket from '../../services/socket';
import { createAppLaunchVideo, getAppLaunchVideos } from '../../services/apiApps';
import { listPipelineMusicLibrary } from '../../services/apiPipeline';
import { trackAudioUrl } from '../../services/apiTracks';
import { formatBytes, formatDateTime, formatDurationSec } from '../../utils/formatters';

const inputClass = 'w-full rounded border border-port-border bg-port-bg p-2 text-port-text';
const buttonClass = 'rounded bg-port-accent px-3 py-2 text-white disabled:opacity-50';
const videoUrl = video => `/data/videos/${encodeURIComponent(video.filename)}`;
const posterUrl = video => `/data/video-thumbnails/${encodeURIComponent(video.thumbnail)}`;

// The run is an agent task, so it takes the same provider/model/effort pin as
// every other manual CoS dispatch. Drawer mounts it only while open, so the
// provider catalog and music library are fetched on demand.
function LaunchVideoForm({ appId, onQueued }) {
  const [tone, setTone] = useState('default');
  const [direction, setDirection] = useState('');
  const [format, setFormat] = useState('landscape');
  const [duration, setDuration] = useState(20);
  const [music, setMusic] = useState(false);
  const [musicTrack, setMusicTrack] = useState('');
  const [tracks, setTracks] = useState(null);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const picker = useRunWithPicker();

  useEffect(() => {
    let active = true;
    listPipelineMusicLibrary({ silent: true }).then(result => {
      if (active) setTracks(result.tracks);
    }).catch(err => { if (active) { setTracks([]); setError(err.message); } });
    return () => { active = false; };
  }, []);

  const [submit, running] = useAsyncAction(async () => {
    if (submitting.current) return;
    submitting.current = true;
    await createAppLaunchVideo(appId, {
      tone, direction, format, targetDurationSec: duration,
      ...(music ? { musicTrack } : {}),
      ...picker.pin,
    }, { silent: true }).then(onQueued).finally(() => { submitting.current = false; });
  });

  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); submit(); }}>
    {error && <p role="alert" className="text-port-error">{error}</p>}
    <section className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-gray-500">Agent</div>
      <ProviderModelSelector {...picker.selectorProps} />
    </section>
    <div><label htmlFor="launch-tone">Tone</label><select id="launch-tone" className={inputClass} value={tone} onChange={event => setTone(event.target.value)}>{['default', 'polished', 'deadpan', 'cinematic', 'parody'].map(value => <option key={value} value={value}>{value}</option>)}</select></div>
    <div><label htmlFor="launch-direction">Direction (optional)</label><textarea id="launch-direction" className={inputClass} maxLength={2000} value={direction} onChange={event => setDirection(event.target.value)} /></div>
    <div><label htmlFor="launch-format">Format</label><select id="launch-format" className={inputClass} value={format} onChange={event => setFormat(event.target.value)}>{['landscape', 'vertical', 'square'].map(value => <option key={value} value={value}>{value}</option>)}</select></div>
    <div><label htmlFor="launch-duration">Duration (15–25 seconds)</label><input id="launch-duration" type="number" min={15} max={25} step={1} required className={inputClass} value={duration} onChange={event => setDuration(event.target.value === '' ? '' : Number(event.target.value))} /></div>
    <div><label htmlFor="launch-music"><input id="launch-music" type="checkbox" checked={music} onChange={event => setMusic(event.target.checked)} /> Include music</label></div>
    {music && <fieldset className="space-y-2">
      <legend>Music-library track</legend>
      {tracks === null && <p className="text-sm text-port-text-muted">Loading tracks…</p>}
      {tracks?.length === 0 && <p>Add a track to the Music library first.</p>}
      {!!tracks?.length && <ul className="max-h-80 space-y-2 overflow-y-auto">
        {tracks.map((track, index) => {
          const id = `launch-track-${index}`;
          const name = track.label || track.filename;
          return <li key={track.filename} className={`rounded border p-2 ${musicTrack === track.filename ? 'border-port-accent' : 'border-port-border'}`}>
            <label htmlFor={id} className="flex cursor-pointer items-start gap-2">
              <input id={id} type="radio" name="launch-track" required value={track.filename} checked={musicTrack === track.filename} onChange={() => setMusicTrack(track.filename)} className="mt-1" />
              <span className="min-w-0">
                <span className="block truncate text-port-text">{name}</span>
                <span className="block truncate font-mono text-xs text-gray-500">{track.filename} · {formatDateTime(track.updatedAt)} · {formatBytes(track.sizeBytes)}</span>
              </span>
            </label>
            <audio controls preload="none" className="mt-2 h-8 w-full" src={trackAudioUrl(track.filename)} aria-label={`Preview ${name}`} />
          </li>;
        })}
      </ul>}
    </fieldset>}
    <p className="text-sm text-port-text-muted">These options are submitted together. Follow and cancel the run in CoS agents.</p>
    <button type="submit" className={buttonClass} disabled={running || duration === '' || (music && !musicTrack)}>{running ? 'Queuing…' : 'Queue launch video'}</button>
  </form>;
}

export default function LaunchVideoPanel({ app }) {
  const [search, updateParams] = useUrlParams();
  const open = search.get('launchVideo') === 'true';
  const [videos, setVideos] = useState([]);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState(false);
  // The previewed take lives in the URL so a specific video is linkable.
  const selected = videos.find(video => video.id === search.get('video')) ?? videos[0];

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

  return <section className="rounded-lg border border-port-border bg-port-card p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-semibold">Launch videos</h2>
      <button type="button" className={buttonClass} onClick={() => { setQueued(false); updateParams({ launchVideo: 'true' }); }}>
        {videos.length ? 'Make another launch video' : 'Make launch video'}
      </button>
    </div>
    <p className="text-sm text-port-text-muted">Plan a short video using recreated screens and fictional content. Nothing is uploaded or posted.</p>
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {!videos.length && !error && <p className="text-sm text-port-text-muted">No launch videos yet.</p>}
    {selected && <div className="space-y-2">
      <video key={selected.id} controls preload="metadata" className="max-h-[60vh] w-full bg-black" src={videoUrl(selected)} poster={posterUrl(selected)} aria-label="Selected launch video" />
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="text-port-text-muted">{formatDateTime(selected.createdAt)}{Number.isFinite(selected.durationSec) ? ` · ${formatDurationSec(selected.durationSec)}` : ''}</span>
        <a className="inline-flex items-center gap-1 text-port-accent" href={videoUrl(selected)} download={`${app.id}-launch-video-${selected.id}.mp4`}><Download size={14} aria-hidden="true" />Download</a>
        <button type="button" className="text-port-accent" onClick={() => copyToClipboard(selected.caption)}>Copy caption</button>
        <Link className="text-port-accent" to="/media/history">Media History</Link>
      </div>
      <p className="whitespace-pre-wrap">{selected.caption}</p>
    </div>}
    {videos.length > 1 && <ul aria-label="Launch video takes" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      {videos.map(video => <li key={video.id}>
        <button type="button" aria-pressed={video.id === selected?.id} onClick={() => updateParams({ video: video.id }, { replace: true })} className={`w-full overflow-hidden rounded border text-left ${video.id === selected?.id ? 'border-port-accent' : 'border-port-border'}`}>
          <img src={posterUrl(video)} alt="" loading="lazy" className="aspect-video w-full object-cover" />
          <span className="block truncate p-1 text-xs text-port-text-muted">{formatDateTime(video.createdAt)}</span>
        </button>
      </li>)}
    </ul>}
    <Drawer open={open} onClose={() => updateParams({ launchVideo: null })} title="Make launch video" size="md">
      {queued ? <div className="space-y-3"><p>Launch video queued. Closing this drawer leaves the run active.</p><Link className="text-port-accent" to="/cos/agents">Open CoS agents to follow or cancel the run</Link></div>
        : <LaunchVideoForm appId={app.id} onQueued={() => setQueued(true)} />}
    </Drawer>
  </section>;
}
