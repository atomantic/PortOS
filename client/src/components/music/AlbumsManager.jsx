/**
 * AlbumsManager — manage albums (ordered track collections under an artist).
 *
 * Master-detail: a list of albums on the left, an editor on the right. An album
 * carries a title, artist (via ArtistPicker), description, genre, release year,
 * cover art (generate via image-gen / upload / gallery — same affordances as the
 * artist portrait), and an ordered list of tracks (add from existing tracks,
 * reorder, remove). Mirrors the Authors/Artists master-detail pattern.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Loader2, Trash2, Save, Upload, ImageIcon, Sparkles, X, ArrowUp, ArrowDown } from 'lucide-react';
import toast from '../ui/Toast';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import { DEFAULT_NEGATIVE_PROMPT } from '../../lib/imageGenDefaults';
import { readFileAsBase64 } from '../../utils/fileUpload';
import { formatTimecode } from '../../utils/formatters';
import ArtistPicker from './ArtistPicker';
import {
  listAlbums, createAlbum, updateAlbum, deleteAlbum,
  listTracks, uploadGalleryImage, generateImage,
  ALBUM_TITLE_MAX, ALBUM_DESCRIPTION_MAX, ALBUM_GENRE_MAX,
  ALBUM_RELEASE_YEAR_MIN, ALBUM_RELEASE_YEAR_MAX,
} from '../../services/api';

const COVER_MAX_BYTES = 12 * 1024 * 1024;

const emptyForm = () => ({
  title: '', artistId: '', artist: '', description: '', genre: '', releaseYear: '', coverImageUrl: '', trackIds: [],
});

const formFromAlbum = (a) => ({
  title: a.title || '',
  artistId: a.artistId || '',
  artist: a.artist || '',
  description: a.description || '',
  genre: a.genre || '',
  releaseYear: a.releaseYear != null ? String(a.releaseYear) : '',
  coverImageUrl: a.coverImageUrl || '',
  trackIds: Array.isArray(a.trackIds) ? a.trackIds : [],
});

// Build the cover-art image-gen prompt from the album's title/genre/artist +
// description. Album covers are square, so callers render at 1024×1024.
const buildCoverPrompt = (f) => {
  const bits = [
    'Album cover art.',
    f.title && `Album: "${f.title.trim()}".`,
    f.artist && `Artist: ${f.artist.trim()}.`,
    f.genre && `Genre: ${f.genre.trim()}.`,
    f.description && f.description.trim(),
  ].filter(Boolean);
  return bits.join(' ');
};

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-gray-500 mt-1">{hint}</span> : null}
    </label>
  );
}

export default function AlbumsManager() {
  const navigate = useNavigate();
  // Selection lives in the URL (`/music/albums/:id`, `/music/albums/new`) so it's
  // deep-linkable and reload-safe. `id === 'new'` = create; a real id = edit.
  const { id } = useParams();
  const [albums, setAlbums] = useState([]);
  const [allTracks, setAllTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [startingGen, setStartingGen] = useState(false);
  const [genJobId, setGenJobId] = useState(null);
  const fileInputRef = useRef(null);
  const genRequestRef = useRef(0);

  const gen = useMediaJobProgress(genJobId);
  const isGenerating = startingGen || !!genJobId;

  const setCover = (url) => setForm((f) => ({ ...f, coverImageUrl: url }));
  const clearGeneration = () => { genRequestRef.current += 1; setGenJobId(null); setStartingGen(false); };

  useEffect(() => {
    Promise.all([
      listAlbums().catch(() => []),
      listTracks({ silent: true }).catch(() => []),
    ])
      .then(([albumList, trackList]) => {
        setAlbums(Array.isArray(albumList) ? albumList : []);
        setAllTracks(Array.isArray(trackList) ? trackList : []);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!genJobId) return;
    if (gen.status === 'completed' && gen.filename) {
      setCover(gen.path || `/data/images/${gen.filename}`);
      setGenJobId(null);
      toast.success('Cover generated');
    } else if (gen.status === 'failed' || gen.status === 'canceled') {
      setGenJobId(null);
      toast.error(gen.error || 'Cover generation failed');
    }
  }, [genJobId, gen.status, gen.filename, gen.path, gen.error]);

  const isCreate = id === 'new';
  const selected = useMemo(
    () => (isCreate || !id ? null : albums.find((a) => a.id === id) || null),
    [albums, id, isCreate],
  );
  const notFound = !isCreate && !!id && !loading && !selected;
  const tracksById = useMemo(() => new Map(allTracks.map((t) => [t.id, t])), [allTracks]);
  const canGenerate = !!(form.title.trim() || form.genre.trim() || form.description.trim());

  const selectAlbum = (a) => navigate(`/music/albums/${encodeURIComponent(a.id)}`);
  const startCreate = () => navigate('/music/albums/new');

  // Hydrate the editor form from the URL-selected album. Keyed on the id so a
  // list refresh doesn't clobber the open form; resets run for every selection
  // change (incl. idle / not-found) so a stray render can't land on the previous
  // album (see Authors.jsx for the base pattern).
  const hydratedRef = useRef(null);
  const selectionKey = id ?? null;
  useEffect(() => {
    if (loading) return;
    if (hydratedRef.current === selectionKey) return;
    hydratedRef.current = selectionKey;
    setConfirmDelete(false);
    clearGeneration();
    if (isCreate) setForm(emptyForm());
    else if (selected) setForm(formFromAlbum(selected));
  }, [selectionKey, isCreate, selected, loading]);

  const handleGenerateCover = async () => {
    if (isGenerating || uploadingCover) return;
    if (!canGenerate) { toast.error('Add a title, genre, or description to generate from'); return; }
    const requestId = genRequestRef.current;
    setStartingGen(true);
    const queued = await generateImage({
      prompt: buildCoverPrompt(form),
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
      width: 1024,
      height: 1024,
    }, { silent: true }).catch((err) => ({ error: err }));
    if (genRequestRef.current !== requestId) return;
    setStartingGen(false);
    if (queued?.error) { toast.error(queued.error.message || 'Cover generation failed'); return; }
    if (queued.jobId) { setGenJobId(queued.jobId); toast.success('Generating cover…'); return; }
    const path = queued.path || (queued.filename ? `/data/images/${queued.filename}` : '');
    if (path) { setCover(path); toast.success('Cover generated'); }
    else toast.error('Cover generation returned no image');
  };

  const handleCoverFile = async (e) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Please choose an image file'); return; }
    if (file.size > COVER_MAX_BYTES) { toast.error(`Image exceeds ${Math.round(COVER_MAX_BYTES / 1024 / 1024)}MB`); return; }
    // Capture the album-switch generation counter (bumped by selectAlbum/
    // startCreate) so a slow read+upload that finishes after the user moved to a
    // different album doesn't write this cover onto the wrong album's form.
    const requestId = genRequestRef.current;
    setUploadingCover(true);
    const base64 = await readFileAsBase64(file).catch(() => null);
    if (!base64) { setUploadingCover(false); toast.error('Could not read that file'); return; }
    const uploaded = await uploadGalleryImage(base64, { silent: true }).catch((err) => { toast.error(err.message || 'Upload failed'); return null; });
    // Always clear the in-flight flag (even on a stale result) so a mid-upload
    // album switch doesn't leave the new album's Upload/Generate stuck disabled.
    setUploadingCover(false);
    if (genRequestRef.current !== requestId) return; // album switched mid-upload — don't write the form
    if (uploaded?.path) { setCover(uploaded.path); toast.success('Cover uploaded'); }
  };

  const handleCoverPick = (item) => {
    setGalleryOpen(false);
    const url = item?.previewUrl || (item?.filename ? `/data/images/${item.filename}` : '');
    if (url) setCover(url);
  };

  // Ordered track-list editing (display-only order is the trackIds array).
  const addTrack = (trackId) => setForm((f) => (f.trackIds.includes(trackId) ? f : { ...f, trackIds: [...f.trackIds, trackId] }));
  const removeTrack = (trackId) => setForm((f) => ({ ...f, trackIds: f.trackIds.filter((id) => id !== trackId) }));
  const moveTrack = (idx, dir) => setForm((f) => {
    const next = [...f.trackIds];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return f;
    [next[idx], next[j]] = [next[j], next[idx]];
    return { ...f, trackIds: next };
  });

  // `includeTrackIds` gates the membership field: on an UPDATE we send `trackIds`
  // only when the user actually reordered/added/removed tracks vs the loaded
  // record — otherwise a metadata-only save on a stale form would re-send an old
  // list and the server's reconcile would clobber a track another tab/API added.
  const buildPayload = ({ includeTrackIds }) => {
    const yearNum = form.releaseYear.trim() === '' ? null : Number(form.releaseYear);
    const payload = {
      title: form.title.trim(),
      artistId: form.artistId,
      artist: form.artist,
      description: form.description,
      genre: form.genre,
      releaseYear: Number.isFinite(yearNum) ? yearNum : null,
      coverImageUrl: form.coverImageUrl,
    };
    if (includeTrackIds) payload.trackIds = form.trackIds;
    return payload;
  };

  const handleSave = async () => {
    const title = form.title.trim();
    if (!title) { toast.error('Album title is required'); return; }
    setSaving(true);
    if (isCreate) {
      const created = await createAlbum(buildPayload({ includeTrackIds: true }), { silent: true }).catch((err) => { toast.error(err.message || 'Failed to create album'); return null; });
      setSaving(false);
      if (!created) return;
      setAlbums((prev) => [...prev, created].sort((a, b) => (a.title || '').localeCompare(b.title || '')));
      navigate(`/music/albums/${encodeURIComponent(created.id)}`);
      toast.success(`Created "${created.title}"`);
    } else {
      // Did the track list actually change vs the loaded record?
      const original = selected?.trackIds || [];
      const trackIdsChanged = original.length !== form.trackIds.length
        || original.some((id, i) => id !== form.trackIds[i]);
      const updated = await updateAlbum(id, buildPayload({ includeTrackIds: trackIdsChanged }), { silent: true }).catch((err) => { toast.error(err.message || 'Failed to save album'); return null; });
      setSaving(false);
      if (!updated) return;
      setAlbums((prev) => prev.map((a) => (a.id === updated.id ? updated : a)).sort((a, b) => (a.title || '').localeCompare(b.title || '')));
      toast.success('Saved');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const prior = albums;
    setAlbums((prev) => prev.filter((a) => a.id !== selected.id));
    setConfirmDelete(false);
    navigate('/music/albums');
    await deleteAlbum(selected.id, { silent: true }).catch((err) => { toast.error(err.message || 'Delete failed'); setAlbums(prior); });
  };

  const availableTracks = allTracks.filter((t) => !form.trackIds.includes(t.id));

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <p className="text-sm text-gray-400 max-w-2xl">
          Albums group ordered tracks under an artist, with cover art. Generate a cover from the title +
          genre, upload one, or pick from your gallery. Add tracks from the Tracks tab and order them here.
        </p>
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium shrink-0"
        >
          <Plus size={16} aria-hidden="true" /> New Album
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        <div className="bg-port-card border border-port-border rounded-lg p-2">
          {loading ? (
            <div className="text-gray-500 text-sm p-2">Loading…</div>
          ) : albums.length === 0 ? (
            <div className="text-gray-500 text-sm p-2">No albums yet. Click <span className="text-port-accent">New Album</span>.</div>
          ) : (
            <ul className="space-y-1">
              {albums.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => selectAlbum(a)}
                    className={`w-full text-left px-2 py-2 rounded text-sm flex items-center gap-2 ${
                      a.id === id ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-bg'
                    }`}
                  >
                    {a.coverImageUrl ? (
                      <img src={a.coverImageUrl} alt="" className="w-8 h-8 rounded object-cover border border-port-border shrink-0" />
                    ) : (
                      <span className="w-8 h-8 rounded border border-port-border bg-port-bg flex items-center justify-center text-gray-600 shrink-0"><ImageIcon size={14} /></span>
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block truncate">{a.title}</span>
                      <span className="block text-[11px] text-gray-500 truncate">{(a.trackIds?.length || 0)} track{(a.trackIds?.length || 0) === 1 ? '' : 's'}{a.genre ? ` · ${a.genre}` : ''}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-4">
          {notFound ? (
            <div className="text-gray-500 text-sm">
              That album could not be found — it may have been deleted.{' '}
              <button type="button" onClick={() => navigate('/music/albums')} className="text-port-accent hover:underline">
                Back to albums
              </button>
            </div>
          ) : !isCreate && !selected ? (
            <div className="text-gray-500 text-sm">Select an album to edit, or create a new one.</div>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-4 items-start">
                {/* Cover art */}
                <div className="shrink-0">
                  {isGenerating ? (
                    <div className="relative w-28 h-28 rounded border border-port-border bg-port-bg overflow-hidden flex items-center justify-center">
                      {gen.currentImage ? (
                        <img src={`data:image/png;base64,${gen.currentImage}`} alt="Generating cover preview" className="w-full h-full object-cover opacity-70" />
                      ) : <Loader2 size={22} className="animate-spin text-port-accent" />}
                      {gen.totalSteps ? (
                        <div className="absolute bottom-0 inset-x-0 bg-black/60 text-[9px] text-white text-center py-0.5 font-mono">{Math.round((gen.step / gen.totalSteps) * 100)}%</div>
                      ) : null}
                    </div>
                  ) : form.coverImageUrl ? (
                    <div className="relative">
                      <img src={form.coverImageUrl} alt="Album cover" className="w-28 h-28 rounded object-cover border border-port-border bg-port-bg" />
                      <button type="button" onClick={() => setCover('')} title="Remove cover" className="absolute -top-2 -right-2 p-1 rounded-full bg-port-bg border border-port-border text-gray-400 hover:text-port-error">
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="w-28 h-28 rounded border border-dashed border-port-border bg-port-bg flex items-center justify-center text-gray-600"><ImageIcon size={24} /></div>
                  )}
                </div>
                <div className="flex-1 space-y-2">
                  <Field label="Title">
                    <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Album title" maxLength={ALBUM_TITLE_MAX} className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white" autoFocus />
                  </Field>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button type="button" onClick={handleGenerateCover} disabled={isGenerating || uploadingCover || !canGenerate} title={canGenerate ? 'Generate a cover' : 'Add a title, genre, or description first'} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50">
                      {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Generate cover
                    </button>
                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingCover || isGenerating} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50">
                      {uploadingCover ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Upload
                    </button>
                    <button type="button" onClick={() => setGalleryOpen(true)} disabled={isGenerating} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50">
                      <ImageIcon size={14} /> Gallery
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" onChange={handleCoverFile} className="hidden" />
                  </div>
                </div>
              </div>

              <Field label="Artist">
                <ArtistPicker id="album-artist" value={form.artistId} name={form.artist} onChange={(artistId, artist) => setForm((f) => ({ ...f, artistId, artist }))} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Genre">
                  <input value={form.genre} onChange={(e) => setForm((f) => ({ ...f, genre: e.target.value }))} placeholder="dream pop" maxLength={ALBUM_GENRE_MAX} className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm" />
                </Field>
                <Field label="Release year">
                  <input type="number" value={form.releaseYear} onChange={(e) => setForm((f) => ({ ...f, releaseYear: e.target.value }))} placeholder="2026" min={ALBUM_RELEASE_YEAR_MIN} max={ALBUM_RELEASE_YEAR_MAX} className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm" />
                </Field>
              </div>
              <Field label="Description" hint="Liner notes / blurb.">
                <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} maxLength={ALBUM_DESCRIPTION_MAX} className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm" />
              </Field>

              <Field label="Tracks" hint="Ordered — reorder with the arrows. Add from your existing tracks.">
                {form.trackIds.length === 0 ? (
                  <p className="text-xs text-gray-500">No tracks on this album yet.</p>
                ) : (
                  <ol className="space-y-1">
                    {form.trackIds.map((tid, idx) => {
                      const t = tracksById.get(tid);
                      return (
                        <li key={tid} className="flex items-center gap-2 px-2 py-1.5 rounded bg-port-bg border border-port-border">
                          <span className="text-[11px] text-gray-500 w-5 text-right">{idx + 1}.</span>
                          <span className="flex-1 min-w-0 truncate text-sm text-gray-200">{t ? t.title : <span className="text-gray-500 italic">(missing track)</span>}</span>
                          {t?.durationSec ? <span className="text-[11px] text-gray-500">{formatTimecode(t.durationSec)}</span> : null}
                          <button type="button" onClick={() => moveTrack(idx, -1)} disabled={idx === 0} className="p-1 text-gray-500 hover:text-white disabled:opacity-30" aria-label="Move up"><ArrowUp size={13} /></button>
                          <button type="button" onClick={() => moveTrack(idx, 1)} disabled={idx === form.trackIds.length - 1} className="p-1 text-gray-500 hover:text-white disabled:opacity-30" aria-label="Move down"><ArrowDown size={13} /></button>
                          <button type="button" onClick={() => removeTrack(tid)} className="p-1 text-gray-500 hover:text-port-error" aria-label="Remove track"><X size={13} /></button>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {availableTracks.length > 0 ? (
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) addTrack(e.target.value); }}
                    className="mt-2 w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                  >
                    <option value="">+ Add a track…</option>
                    {availableTracks.map((t) => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-[11px] text-gray-500 mt-2">All your tracks are on this album. Create more in the Tracks tab.</p>
                )}
              </Field>

              <div className="flex items-center gap-2 pt-1 flex-wrap">
                <button type="button" onClick={handleSave} disabled={saving || !form.title.trim()} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {isCreate ? 'Create' : 'Save'}
                </button>
                {!isCreate && selected ? (
                  confirmDelete ? (
                    <span className="inline-flex items-center gap-2 text-sm">
                      <span className="text-port-error">Delete this album?</span>
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

      <GalleryImagePicker open={galleryOpen} onClose={() => setGalleryOpen(false)} onSelect={handleCoverPick} />
    </div>
  );
}
