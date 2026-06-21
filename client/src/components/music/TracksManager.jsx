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
import { Plus, Loader2, Trash2, Save, Upload, Music2, X, Library } from 'lucide-react';
import toast from '../ui/Toast';
import { formatTimecode } from '../../utils/formatters';
import ArtistPicker from './ArtistPicker';
import {
  listTracks, createTrack, updateTrack, deleteTrack,
  uploadTrackAudio, attachTrackAudio, clearTrackAudio, listMusicLibrary, listAlbums,
  TRACK_TITLE_MAX, TRACK_LYRICS_MAX, TRACK_PROMPT_MAX,
} from '../../services/api';

// Cap audio uploads to match the server's MUSIC_UPLOAD_MAX_BYTES (50MB).
const AUDIO_MAX_BYTES = 50 * 1024 * 1024;
const AUDIO_SRC = (filename) => `/data/music/${encodeURIComponent(filename)}`;

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
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null); // 'new' | id | null
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState([]);
  const [albums, setAlbums] = useState([]);
  const fileInputRef = useRef(null);
  // Mirrors `selectedId` so async audio handlers can detect a selection change
  // that happened while their server round-trip was in flight (the server write
  // still targets the original track id; only the open form must not be clobbered
  // with another track's result).
  const selectedIdRef = useRef(null);

  useEffect(() => {
    Promise.all([
      listTracks().catch((err) => { toast.error(err.message || 'Failed to load tracks'); return []; }),
      listAlbums({ silent: true }).catch(() => []),
    ])
      .then(([trackList, albumList]) => {
        setTracks(Array.isArray(trackList) ? trackList : []);
        setAlbums(Array.isArray(albumList) ? albumList : []);
      })
      .finally(() => setLoading(false));
  }, []);

  const isCreate = selectedId === 'new';
  const selected = useMemo(
    () => (isCreate || !selectedId ? null : tracks.find((t) => t.id === selectedId) || null),
    [tracks, selectedId, isCreate],
  );
  // The persisted track (for gen metadata + the audio player, which need a saved id).
  const persisted = selected;

  const selectTrack = (t) => {
    setSelectedId(t.id);
    selectedIdRef.current = t.id;
    setForm(formFromTrack(t));
    setConfirmDelete(false);
    setLibraryOpen(false);
  };

  const startCreate = () => {
    setSelectedId('new');
    selectedIdRef.current = 'new';
    setForm(emptyForm());
    setConfirmDelete(false);
    setLibraryOpen(false);
  };

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
      const created = await createTrack({ ...form, title }).catch((err) => { toast.error(err.message || 'Failed to create track'); return null; });
      setSaving(false);
      if (!created) return;
      upsertLocal(created);
      setSelectedId(created.id);
      selectedIdRef.current = created.id;
      toast.success(`Created "${created.title}"`);
    } else {
      // Drop `albumId` from a metadata-only update unless the user actually
      // changed the album here — otherwise a stale form would re-send the old
      // albumId and the server's reconcile would move the track back (a track
      // reassigned in another tab/API would get clobbered). The album editor
      // remains the primary place to (re)order an album's tracks.
      const payload = { ...form, title };
      if ((selected?.albumId || '') === form.albumId) delete payload.albumId;
      const updated = await updateTrack(selectedId, payload).catch((err) => { toast.error(err.message || 'Failed to save track'); return null; });
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
    setSelectedId(null);
    setConfirmDelete(false);
    await deleteTrack(selected.id).catch((err) => { toast.error(err.message || 'Delete failed'); setTracks(prior); });
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

  const removeAudio = async () => {
    if (!persisted) { setForm((f) => ({ ...f, audioFilename: '' })); return; }
    const targetId = persisted.id;
    const res = await clearTrackAudio(targetId, { silent: true }).catch((err) => { toast.error(err.message || 'Failed to clear audio'); return null; });
    if (res?.track) {
      upsertLocal(res.track);
      if (selectedIdRef.current === targetId) setForm((f) => ({ ...f, audioFilename: '' }));
    }
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
                      t.id === selectedId ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-bg'
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
          {!isCreate && !selected ? (
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

              {/* Generation metadata (read-only) — populated when a track is generated. */}
              {persisted && (persisted.engine || persisted.modelId || persisted.durationSec) ? (
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  {persisted.engine ? <span className="px-2 py-0.5 rounded-full bg-port-bg border border-port-border text-gray-400">engine: {persisted.engine}</span> : null}
                  {persisted.modelId ? <span className="px-2 py-0.5 rounded-full bg-port-bg border border-port-border text-gray-400">model: {persisted.modelId}</span> : null}
                  {persisted.durationSec ? <span className="px-2 py-0.5 rounded-full bg-port-bg border border-port-border text-gray-400">{formatTimecode(persisted.durationSec)}</span> : null}
                </div>
              ) : null}

              <Field label="Audio" hint="Upload an audio file or attach one from the shared music library. Save the track first.">
                {form.audioFilename ? (
                  <div className="space-y-2">
                    <audio controls src={AUDIO_SRC(form.audioFilename)} className="w-full">
                      <track kind="captions" />
                    </audio>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-gray-500 truncate flex-1">{form.audioFilename}</span>
                      <button
                        type="button"
                        onClick={removeAudio}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-gray-400 hover:text-port-error text-xs"
                      >
                        <X size={12} /> Remove
                      </button>
                    </div>
                  </div>
                ) : (
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
                )}
                {libraryOpen ? (
                  <div className="mt-2 border border-port-border rounded-lg bg-port-bg max-h-48 overflow-y-auto">
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
              </Field>

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
    </div>
  );
}
