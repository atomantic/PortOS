/**
 * TracksManager — manage music tracks (singles or album members).
 *
 * Master-detail: a list of tracks on the left, an editor on the right. A track
 * carries a title, an artist (via ArtistPicker), lyrics + a generation prompt,
 * and an audio file. Audio is stored in the shared music library; the editor
 * uploads a file or attaches an existing library track, and plays it inline.
 *
 * On-device generation (engine/model/duration) lands in Phase 4 — for now the
 * engine/model/duration are shown as read-only metadata on a generated track
 * and the prompt/lyrics fields are captured so a later Generate button can use
 * them. Mirrors the Authors/Artists master-detail pattern.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Loader2, Trash2, Save, Upload, Music2, Library } from 'lucide-react';
import toast from '../ui/Toast';
import { formatTimecode } from '../../utils/formatters';
import ArtistPicker from './ArtistPicker';
import MusicGenPanel from './MusicGenPanel';
import TrackRenderCard from './TrackRenderCard';
import TrackRenderModal from './TrackRenderModal';
import MidiVisualization from '../songs/MidiVisualization.jsx';
import { listMusicVideoProjects } from '../../services/apiMusicVideo.js';
import { trackAudioUrl } from '../../services/apiTracks.js';
import {
  listTracks, createTrack, updateTrack, deleteTrack,
  uploadTrackAudio, attachTrackAudio, listMusicLibrary, listAlbums,
  selectTrackRender, deleteTrackRender,
  TRACK_TITLE_MAX, TRACK_LYRICS_MAX, TRACK_PROMPT_MAX,
} from '../../services/api';

// Cap audio uploads to match the server's MUSIC_UPLOAD_MAX_BYTES (50MB).
const AUDIO_MAX_BYTES = 50 * 1024 * 1024;

const emptyForm = () => ({
  title: '', albumId: '', artistId: '', artist: '', lyrics: '', prompt: '', audioFilename: '',
});

const formFromTrack = (t) => ({
  title: t.title || '',
  albumId: t.albumId || '',
  artistId: t.artistId || '',
  artist: t.artist || '',
  lyrics: t.lyrics || '',
  prompt: t.prompt || '',
  audioFilename: t.audioFilename || '',
});

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-gray-500 mt-1">{hint}</span> : null}
    </label>
  );
}

export default function TracksManager() {
  const navigate = useNavigate();
  // Selection lives in the URL (`/music/tracks/:id`, `/music/tracks/new`) so it's
  // deep-linkable and reload-safe. `id === 'new'` = create; a real id = edit.
  const { id } = useParams();
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState([]);
  const [albums, setAlbums] = useState([]);
  // The render shown in the detail/remix modal, and the seed passed to the gen
  // panel when remixing (nonce bumps per click so re-remixing the same take
  // re-applies). See remixRender below.
  const [modalRender, setModalRender] = useState(null);
  const [remix, setRemix] = useState(null);
  // Music Video projects, for the MIDI read-through: MuScriptor transcriptions
  // are stored on the MV project that links a track, not on the track itself.
  const [mvProjects, setMvProjects] = useState([]);
  const remixNonceRef = useRef(0);
  const fileInputRef = useRef(null);
  // Mirrors `selectedId` so async audio handlers can detect a selection change
  // that happened while their server round-trip was in flight (the server write
  // still targets the original track id; only the open form must not be clobbered
  // with another track's result).
  const selectedIdRef = useRef(null);

  useEffect(() => {
    Promise.all([
      listTracks({ silent: true }).catch((err) => { toast.error(err.message || 'Failed to load tracks'); return []; }),
      listAlbums({ silent: true }).catch(() => []),
      listMusicVideoProjects({ silent: true }).catch(() => []),
    ])
      .then(([trackList, albumList, mvList]) => {
        setTracks(Array.isArray(trackList) ? trackList : []);
        setAlbums(Array.isArray(albumList) ? albumList : []);
        setMvProjects(Array.isArray(mvList) ? mvList : []);
      })
      .finally(() => setLoading(false));
  }, []);

  const isCreate = id === 'new';
  const selected = useMemo(
    () => (isCreate || !id ? null : tracks.find((t) => t.id === id) || null),
    [tracks, id, isCreate],
  );
  const notFound = !isCreate && !!id && !loading && !selected;
  // The persisted track (for gen metadata + the audio player, which need a saved id).
  const persisted = selected;

  // Reset per-track view state on any selection change. The render modal + remix
  // seed belong to the previously-selected track; without clearing them, a modal
  // left open across a track switch would drive its Use/Delete/Remix against the
  // NEWLY selected track (the action handlers read persisted?.id), sending the
  // old render's id to the wrong track.
  const resetTrackViewState = () => {
    setConfirmDelete(false);
    setLibraryOpen(false);
    setModalRender(null);
    setRemix(null);
  };

  const selectTrack = (t) => navigate(`/music/tracks/${encodeURIComponent(t.id)}`);
  const startCreate = () => navigate('/music/tracks/new');

  // Hydrate the editor form from the URL-selected track. Keyed on the id so a
  // list refresh (audio upload, generate, upsertLocal) doesn't clobber the open
  // form; `selectedIdRef` is kept in sync so async handlers can still detect a
  // selection change that happened mid-round-trip. Per-track view state is reset
  // for every selection change (incl. idle / not-found) so a modal/remix left
  // open can't drive the previous track (see Authors.jsx for the base pattern).
  const hydratedRef = useRef(null);
  const selectionKey = id ?? null;
  useEffect(() => {
    if (loading) return;
    if (hydratedRef.current === selectionKey) return;
    hydratedRef.current = selectionKey;
    selectedIdRef.current = selectionKey;
    resetTrackViewState();
    if (isCreate) setForm(emptyForm());
    else if (selected) setForm(formFromTrack(selected));
  }, [selectionKey, isCreate, selected, loading]);

  const upsertLocal = (track) => {
    setTracks((prev) => {
      const exists = prev.some((t) => t.id === track.id);
      return exists ? prev.map((t) => (t.id === track.id ? track : t)) : [...prev, track];
    });
  };

  const handleSave = async () => {
    const title = form.title.trim();
    if (!title) { toast.error('Track title is required'); return; }
    setSaving(true);
    if (isCreate) {
      const created = await createTrack({ ...form, title }, { silent: true }).catch((err) => { toast.error(err.message || 'Failed to create track'); return null; });
      setSaving(false);
      if (!created) return;
      upsertLocal(created);
      // Point the async-handler ref at the new id immediately (the hydration
      // effect also sets it, but not until after navigation re-renders).
      selectedIdRef.current = created.id;
      navigate(`/music/tracks/${encodeURIComponent(created.id)}`);
      toast.success(`Created "${created.title}"`);
    } else {
      // Drop `albumId` from a metadata-only update unless the user actually
      // changed the album here — otherwise a stale form would re-send the old
      // albumId and the server's reconcile would move the track back (a track
      // reassigned in another tab/API would get clobbered). The album editor
      // remains the primary place to (re)order an album's tracks.
      const payload = { ...form, title };
      if ((selected?.albumId || '') === form.albumId) delete payload.albumId;
      const updated = await updateTrack(id, payload, { silent: true }).catch((err) => { toast.error(err.message || 'Failed to save track'); return null; });
      setSaving(false);
      if (!updated) return;
      upsertLocal(updated);
      toast.success('Saved');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const prior = tracks;
    setTracks((prev) => prev.filter((t) => t.id !== selected.id));
    resetTrackViewState();
    navigate('/music/tracks');
    await deleteTrack(selected.id, { silent: true }).catch((err) => { toast.error(err.message || 'Delete failed'); setTracks(prior); });
  };

  // Audio actions operate on the SAVED track (the server attaches the filename
  // and returns the updated record). A brand-new unsaved track must be saved first.
  const requireSaved = () => {
    if (!persisted) { toast.error('Save the track first, then add audio'); return false; }
    return true;
  };

  const handleAudioFile = async (e) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file || !requireSaved()) return;
    if (file.size > AUDIO_MAX_BYTES) { toast.error(`Audio exceeds ${Math.round(AUDIO_MAX_BYTES / 1024 / 1024)}MB`); return; }
    const targetId = persisted.id; // server write targets THIS track
    setUploading(true);
    const fd = new FormData();
    fd.append('track', file, file.name);
    const res = await uploadTrackAudio(targetId, fd, { silent: true }).catch((err) => { toast.error(err.message || 'Upload failed'); return null; });
    setUploading(false);
    if (res?.track) {
      upsertLocal(res.track); // list update is id-keyed → always safe
      // Only touch the open form if THIS track is still selected (the user may
      // have switched tracks during the upload round-trip).
      if (selectedIdRef.current === targetId) setForm((f) => ({ ...f, audioFilename: res.track.audioFilename }));
      toast.success('Audio uploaded');
    }
  };

  const openLibrary = async () => {
    if (!requireSaved()) return;
    const targetId = persisted.id;
    const res = await listMusicLibrary({ silent: true }).catch(() => null);
    // The user may have switched tracks (or to a new unsaved one) while the
    // library list loaded — don't pop the picker open for a stale selection.
    if (selectedIdRef.current !== targetId) return;
    setLibrary(Array.isArray(res?.tracks) ? res.tracks : []);
    setLibraryOpen(true);
  };

  const attachFromLibrary = async (filename) => {
    setLibraryOpen(false);
    // Re-resolve the target from the live selection rather than a possibly-stale
    // `persisted` — and bail if there's no saved track to attach to.
    const targetId = selectedIdRef.current;
    if (!targetId || targetId === 'new') { toast.error('Save the track first, then add audio'); return; }
    const res = await attachTrackAudio(targetId, filename, { silent: true }).catch((err) => { toast.error(err.message || 'Attach failed'); return null; });
    if (res?.track) {
      upsertLocal(res.track);
      if (selectedIdRef.current === targetId) setForm((f) => ({ ...f, audioFilename: res.track.audioFilename }));
      toast.success('Audio attached');
    }
  };

  // MIDI read-through: the newest transcription among Music Video projects
  // linked to this track. Transcriptions are made (and stored) on the MV
  // project, but the piano-roll is just as useful when inspecting the track.
  const midiSource = useMemo(() => {
    if (!persisted?.id) return null;
    const linked = mvProjects.filter((p) => p.trackId === persisted.id && p.midiTranscription?.filename);
    if (!linked.length) return null;
    return linked.sort((a, b) => (b.midiTranscription.createdAt || '').localeCompare(a.midiTranscription.createdAt || ''))[0];
  }, [mvProjects, persisted]);

  // Render history — newest first. The active take (the top-level audioFilename
  // pointer) is highlighted in the grid.
  const renders = useMemo(() => {
    const list = Array.isArray(persisted?.renders) ? [...persisted.renders] : [];
    return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [persisted]);
  const activeFilename = persisted?.audioFilename || '';

  // After a server-confirmed render mutation, sync the list + mirror the active
  // pointer into the open form (only when THIS track is still selected — the
  // user may have switched tracks during the round-trip).
  const applyRenderResult = (res, targetId) => {
    if (!res?.track) return;
    upsertLocal(res.track);
    if (selectedIdRef.current === targetId) setForm((f) => ({ ...f, audioFilename: res.track.audioFilename || '' }));
  };

  const selectRender = async (render) => {
    const targetId = persisted?.id;
    if (!targetId) return;
    const res = await selectTrackRender(targetId, render.id, { silent: true })
      .catch((err) => { toast.error(err.message || 'Failed to select render'); return null; });
    applyRenderResult(res, targetId);
  };

  const deleteRender = async (render) => {
    const targetId = persisted?.id;
    if (!targetId) return;
    setModalRender((m) => (m?.id === render.id ? null : m));
    const res = await deleteTrackRender(targetId, render.id, { silent: true })
      .catch((err) => { toast.error(err.message || 'Failed to delete render'); return null; });
    applyRenderResult(res, targetId);
  };

  // Remix: prefill the editable prompt/lyrics from the take (guard empties so an
  // uploaded take can't wipe the user's text), seed the gen panel's engine/
  // model/duration, and close the modal so the panel is in view.
  const remixRender = (render) => {
    setModalRender(null);
    setForm((f) => ({
      ...f,
      ...(render.prompt ? { prompt: render.prompt } : {}),
      ...(render.lyrics ? { lyrics: render.lyrics } : {}),
    }));
    remixNonceRef.current += 1;
    setRemix({ engineId: render.engine, modelId: render.modelId, durationSec: render.durationSec, nonce: remixNonceRef.current });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <p className="text-sm text-gray-400 max-w-2xl">
          Tracks are singles or album members. Set the artist, write lyrics and a generation prompt, then
          upload an audio file or attach one from your music library. On-device generation lands next update.
        </p>
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium shrink-0"
        >
          <Plus size={16} aria-hidden="true" /> New Track
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        <div className="bg-port-card border border-port-border rounded-lg p-2">
          {loading ? (
            <div className="text-gray-500 text-sm p-2">Loading…</div>
          ) : tracks.length === 0 ? (
            <div className="text-gray-500 text-sm p-2">No tracks yet. Click <span className="text-port-accent">New Track</span>.</div>
          ) : (
            <ul className="space-y-1">
              {tracks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => selectTrack(t)}
                    className={`w-full text-left px-3 py-2 rounded text-sm truncate flex items-center gap-2 ${
                      t.id === id ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-bg'
                    }`}
                  >
                    <Music2 size={13} className={t.audioFilename ? 'text-port-success shrink-0' : 'text-gray-600 shrink-0'} aria-hidden="true" />
                    <span className="flex-1 min-w-0 truncate">{t.title}</span>
                    {t.durationSec ? <span className="text-[11px] text-gray-500 shrink-0">{formatTimecode(t.durationSec)}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-4">
          {notFound ? (
            <div className="text-gray-500 text-sm">
              That track could not be found — it may have been deleted.{' '}
              <button type="button" onClick={() => navigate('/music/tracks')} className="text-port-accent hover:underline">
                Back to tracks
              </button>
            </div>
          ) : !isCreate && !selected ? (
            <div className="text-gray-500 text-sm">Select a track to edit, or create a new one.</div>
          ) : (
            <div className="space-y-3">
              <Field label="Title">
                <input
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Track title"
                  maxLength={TRACK_TITLE_MAX}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                  autoFocus
                />
              </Field>
              <Field label="Artist">
                <ArtistPicker
                  id="track-artist"
                  value={form.artistId}
                  name={form.artist}
                  onChange={(artistId, artist) => setForm((f) => ({ ...f, artistId, artist }))}
                />
              </Field>
              <Field label="Album" hint="Optional — none means a standalone single. Saving syncs the album's tracklist.">
                <select
                  id="track-album"
                  value={form.albumId}
                  onChange={(e) => setForm((f) => ({ ...f, albumId: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                >
                  <option value="">— Single (no album) —</option>
                  {albums.map((a) => (
                    <option key={a.id} value={a.id}>{a.title}</option>
                  ))}
                  {form.albumId && !albums.some((a) => a.id === form.albumId) ? (
                    <option value={form.albumId}>Linked album (unavailable)</option>
                  ) : null}
                </select>
              </Field>
              <Field label="Prompt" hint="Text/style prompt for generation (used by the upcoming on-device generators).">
                <textarea
                  value={form.prompt}
                  onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                  rows={2}
                  maxLength={TRACK_PROMPT_MAX}
                  placeholder="Warm fingerpicked folk, breathy vocals, tape hiss, 90 BPM."
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Lyrics" hint="Full lyrics — also the conditioning text for lyric-aware generators (Ace-Step).">
                <textarea
                  value={form.lyrics}
                  onChange={(e) => setForm((f) => ({ ...f, lyrics: e.target.value }))}
                  rows={6}
                  maxLength={TRACK_LYRICS_MAX}
                  placeholder={'[verse]\n…\n[chorus]\n…'}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono"
                />
              </Field>

              {/* On-device generation — available once the track is saved (the
                  server attaches the audio + metadata to the persisted track).
                  Uses the CURRENT prompt/lyrics in the form; `remix` seeds the
                  engine/model/duration from a past take. */}
              {persisted ? (
                <MusicGenPanel
                  track={persisted}
                  prompt={form.prompt}
                  lyrics={form.lyrics}
                  remix={remix}
                  onGenerated={(updated) => {
                    upsertLocal(updated); // list update is id-keyed → always safe
                    // Merge ONLY the server-set generation fields into the open
                    // form (the active audio pointer mirrors onto the form) so any
                    // UNSAVED edits the user made to title/artist/album/prompt/
                    // lyrics before clicking Generate survive.
                    if (selectedIdRef.current === updated.id) {
                      setForm((f) => ({ ...f, audioFilename: updated.audioFilename || '' }));
                    }
                  }}
                />
              ) : null}

              {/* Render history — every generated/uploaded take as a card. The
                  active take is highlighted; each card opens a detail/remix modal,
                  can be made active, remixed, downloaded, or deleted. */}
              {persisted ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="block text-xs uppercase tracking-wider text-gray-500">
                      Renders{renders.length ? ` (${renders.length})` : ''}
                    </span>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => (requireSaved() ? fileInputRef.current?.click() : null)}
                        disabled={uploading}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"
                      >
                        {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Upload
                      </button>
                      <button
                        type="button"
                        onClick={openLibrary}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent"
                      >
                        <Library size={14} /> From library
                      </button>
                      <input ref={fileInputRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac" onChange={handleAudioFile} className="hidden" />
                    </div>
                  </div>

                  {renders.length === 0 ? (
                    <div className="text-xs text-gray-500 border border-dashed border-port-border rounded-lg p-4 text-center">
                      No renders yet. Generate above, upload a file, or attach one from your library.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {renders.map((r) => (
                        <TrackRenderCard
                          key={r.id}
                          render={r}
                          active={r.audioFilename === activeFilename}
                          onOpen={(rr) => setModalRender(rr)}
                          onSelect={selectRender}
                          onRemix={remixRender}
                          onDelete={deleteRender}
                        />
                      ))}
                    </div>
                  )}

                  {libraryOpen ? (
                    <div className="mt-1 border border-port-border rounded-lg bg-port-bg max-h-48 overflow-y-auto">
                      {library.length === 0 ? (
                        <div className="text-xs text-gray-500 p-3">The music library is empty — upload a track first.</div>
                      ) : (
                        <ul className="divide-y divide-port-border">
                          {library.map((item) => (
                            <li key={item.filename}>
                              <button
                                type="button"
                                onClick={() => attachFromLibrary(item.filename)}
                                className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-port-card flex items-center gap-2"
                              >
                                <Music2 size={13} className="text-gray-500 shrink-0" />
                                <span className="flex-1 min-w-0 truncate">{item.label || item.filename}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-gray-500">Save the track first to generate, upload, or attach audio.</p>
              )}

              {/* MIDI piano-roll (#2477) — read through from the linked Music
                  Video project that ran the MuScriptor transcription. */}
              {midiSource ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="block text-xs uppercase tracking-wider text-gray-500">MIDI transcription</span>
                    <Link
                      to={`/music-video/${encodeURIComponent(midiSource.id)}`}
                      className="text-[11px] text-port-accent hover:underline"
                    >
                      from Music Video “{midiSource.name}” →
                    </Link>
                  </div>
                  <MidiVisualization
                    url={trackAudioUrl(midiSource.midiTranscription.filename)}
                    filename={midiSource.midiTranscription.filename}
                    model={midiSource.midiTranscription.model}
                  />
                </div>
              ) : null}

              <div className="flex items-center gap-2 pt-1 flex-wrap">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !form.title.trim()}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {isCreate ? 'Create' : 'Save'}
                </button>
                {!isCreate && selected ? (
                  confirmDelete ? (
                    <span className="inline-flex items-center gap-2 text-sm">
                      <span className="text-port-error">Delete this track?</span>
                      <button type="button" onClick={handleDelete} className="px-2 py-1 rounded bg-port-error/20 text-port-error hover:bg-port-error/30">Yes, delete</button>
                      <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1 rounded text-gray-400 hover:text-white">Cancel</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-gray-400 hover:text-port-error text-sm">
                      <Trash2 size={14} /> Delete
                    </button>
                  )
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>

      {modalRender ? (
        <TrackRenderModal
          render={modalRender}
          active={modalRender.audioFilename === activeFilename}
          onClose={() => setModalRender(null)}
          onSelect={selectRender}
          onRemix={remixRender}
          onDelete={deleteRender}
        />
      ) : null}
    </div>
  );
}
