import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useSocketResource } from '../../hooks/useSocketResource';
import { useSocketSubscription } from '../../hooks/useSocketSubscription';
import useMusicVideoBlender from '../../hooks/useMusicVideoBlender.js';
import { getCodeAnimationProject } from '../../services/apiCodeAnimation';
import { listTracks, uploadFile } from '../../services/api';
import * as api from '../../services/apiCodeAnimationFilm.js';
import BlenderFilmPanel from '../musicVideo/BlenderFilmPanel.jsx';
import FilmLivePreview from '../musicVideo/blender/FilmLivePreview.jsx';
import AlbumTrackPicker from '../music/AlbumTrackPicker';
import MediaPreview from '../media/MediaPreview.jsx';
import useHydratedPreviewRoute from '../../hooks/useHydratedPreviewRoute.js';
import { BLENDER_TAB_IDS, blenderStillPreviewItems } from '../../lib/musicVideoBlender.js';
import { buttonCls, inputCls } from '../musicVideo/blender/blenderStyles.js';

const EVENTS = ['code-animation:changed'];

function FilmDetails({ project, onSave, onAudio, busy }) {
  const [draft, setDraft] = useState({});
  const title = draft.title ?? project.title;
  const durationSec = draft.durationSec ?? project.film.timeline.durationSec;
  return <form className="flex flex-wrap items-end gap-3" onSubmit={async event => { event.preventDefault(); const result = await onSave({ title,
    ...(!project.film.audio?.filename ? { timeline: { durationSec, fps: project.film.settings.fps } } : {}) }); if (result) setDraft({}); }}>
    <div><label htmlFor="film-title" className="block text-xs">Title</label><input id="film-title" className={inputCls} value={title} disabled={busy} maxLength={200} required onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} /></div>
    <div><label htmlFor="film-duration" className="block text-xs">Duration (seconds)</label><input id="film-duration" type="number" min={1} max={3600} step="any" className={inputCls}
      disabled={busy || !!project.film.audio?.filename} value={durationSec} onChange={event => setDraft(current => ({ ...current, durationSec: Number(event.target.value) }))} /></div>
    <button className={buttonCls} disabled={busy}>Save film details</button>
    {project.film.audio?.filename && <button type="button" className={buttonCls} disabled={busy} onClick={() => onAudio({ source: 'none' })}>Remove soundtrack</button>}
  </form>;
}

export default function ProductionFilm() {
  const { filmId, tab = 'shots', shotId } = useParams();
  const navigate = useNavigate();
  useSocketSubscription('code-animation');
  const resource = useSocketResource(({ signal }) => getCodeAnimationProject(filmId, { signal, silent: true }), {
    namespace: 'code-animation', events: EVENTS, resourceKey: filmId, matchesEvent: payload => payload?.id === filmId,
  });
  const blender = useMusicVideoBlender(filmId, { api, socketChannel: 'code-animation:film' });
  const previewItems = useMemo(() => blenderStillPreviewItems(blender.state, path => api.musicVideoBlenderMediaUrl(filmId, path)), [blender.state, filmId]);
  const [preview, setPreview] = useHydratedPreviewRoute(previewItems);
  const openPreview = key => setPreview(previewItems.find(item => item.key === key) || null);
  const [act, busy] = useAsyncAction(async operation => operation());
  const [tracks, setTracks] = useState([]);
  const [picker, setPicker] = useState(null);
  const [promotion, setPromotion] = useState(null);
  const promote = input => act(async () => {
    const result = await api.promoteFilm(filmId, input, { silent: true });
    setPromotion({ filmId, ...result });
  });
  const pickTrack = mode => act(async () => {
    const rows = await listTracks({ silent: true });
    setTracks(Array.isArray(rows) ? rows : rows?.tracks || []);
    setPicker({ filmId, mode });
  });
  const attach = input => act(async () => { resource.updateData(await api.attachAudio(filmId, input, { silent: true })); await blender.refresh(); });
  const project = resource.data;
  const base = `/code-animation/production/films/${filmId}`;
  const onTabChange = next => navigate(`${base}/${next}${shotId ? `/${shotId}` : ''}`);
  if (resource.error) return <div role="alert">{resource.error.message}<button className={buttonCls} onClick={resource.refetch}>Retry film</button></div>;
  if (!project) return <p>Loading film…</p>;
  if (project.kind !== 'film') return <p>This is a package project. <Link to={`/code-animation/production/${filmId}`}>Open package</Link></p>;
  const audioUrl = blender.state?.audioUrl || null;
  return <div className="min-w-0 space-y-4">
    <Link to="/code-animation/production" className="text-port-accent">All Production projects</Link>
    <h2 className="text-lg font-semibold">{project.title}</h2>
    <FilmDetails key={filmId} project={project} busy={busy}
      onSave={input => act(async () => { const saved = await api.patchFilm(filmId, input, { silent: true }); resource.updateData(saved); await blender.refresh(); return saved; })} onAudio={attach} />
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={buttonCls} disabled={busy} onClick={() => pickTrack('attach')}>Attach library track and analyze</button>
      <button type="button" className={buttonCls} disabled={busy} onClick={() => pickTrack('promote')}>Send to Music Video</button>
      <div><label htmlFor="film-upload-audio" className="block text-xs">Upload and analyze soundtrack</label><input id="film-upload-audio" type="file" accept="audio/*" disabled={busy} className="max-w-full text-xs" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) act(async () => { const upload = await uploadFile(file, file.name, { silent: true });
          resource.updateData(await api.attachAudio(filmId, { source: 'upload', filename: upload.filename }, { silent: true })); await blender.refresh(); });
      }} /></div>
      {busy && <p role="status" className="text-xs">Working locally…</p>}
    </div>
    <p className="text-xs text-port-text-muted">Soundtrack analysis runs locally when attached. Audio sets the film length; without audio, the timeline is silent. No AI provider is called.</p>
    {promotion?.filmId === filmId && <div role="status" className="space-y-1 text-sm">
      <Link className="text-port-accent" to={`/music-video/${promotion.project.id}`}>Open {promotion.project.name} in Music Video</Link>
      <p>The copy needs song analysis and a shot sync. Sending starts no jobs.</p>
      {promotion.coverageProblems.length > 0 && <ul className="list-disc pl-5">{promotion.coverageProblems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
    </div>}
    {project.promotedTo && promotion?.filmId !== filmId && <Link className="text-sm text-port-accent" to={`/music-video/${project.promotedTo}`}>Open latest Music Video copy</Link>}
    <FilmLivePreview key={filmId} state={blender.state} durationSec={project.film.timeline.durationSec} audioUrl={audioUrl} mediaUrl={path => api.musicVideoBlenderMediaUrl(filmId, path)} />
    <BlenderFilmPanel api={api} standalone tab={BLENDER_TAB_IDS.includes(tab) ? tab : 'shots'} onTabChange={onTabChange} shotId={shotId || ''}
      onShotChange={id => navigate(`${base}/shots/${id}`)} board={{ project: { ...project, audioAnalysis: project.film.analysis }, blender, audioUrl, openPreview }} />
    {blender.state?.finalStale && <p className="text-xs text-port-warning">The accepted output is behind the current film. Render current finals and assemble again to replace it.</p>}
    {blender.state?.acceptedOutput && <p className="text-sm"><a href={blender.state.acceptedOutput.path} className="text-port-accent">Open accepted final in Media History output</a></p>}
    <MediaPreview preview={preview} setPreview={setPreview} items={previewItems} />
    <AlbumTrackPicker open={picker?.filmId === filmId} tracks={tracks.filter(track => track.audioFilename)} single
      title={picker?.mode === 'promote' ? 'Send to Music Video' : 'Attach soundtrack'} onClose={() => setPicker(null)}
      onAdd={selected => picker.mode === 'promote' ? promote({ trackId: selected[0].id }) : attach({ source: 'track', trackId: selected[0].id })} />
  </div>;
}
