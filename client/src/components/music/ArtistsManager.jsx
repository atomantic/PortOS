/**
 * ArtistsManager — manage reusable music-artist personas (the Music studio's
 * analogue of the Authors page). Master-detail: a selectable list on the left,
 * an editor on the right. An Artist carries a name, genre, bio, musical style,
 * plus a physical description + portrait style used to generate (or upload) an
 * artist portrait. Mirrors pages/Authors.jsx — same portrait
 * generate/upload/gallery affordances, reusing the image-gen pipeline.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Loader2, Trash2, Save, Upload, ImageIcon, Sparkles, X } from 'lucide-react';
import toast from '../ui/Toast';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import { DEFAULT_NEGATIVE_PROMPT } from '../../lib/imageGenDefaults';
import { readFileAsBase64 } from '../../utils/fileUpload';
import {
  listArtists, createArtist, updateArtist, deleteArtist, uploadGalleryImage, generateImage,
  ARTIST_NAME_MAX, ARTIST_GENRE_MAX, ARTIST_BIO_MAX, ARTIST_MUSICAL_STYLE_MAX,
  ARTIST_PHYSICAL_DESCRIPTION_MAX, ARTIST_PORTRAIT_STYLE_MAX, ARTIST_PORTRAIT_IMAGE_URL_MAX,
} from '../../services/api';

// Cap portrait uploads so the base64 round-trip stays small.
const PORTRAIT_MAX_BYTES = 12 * 1024 * 1024;

const emptyForm = () => ({
  name: '', genre: '', bio: '', musicalStyle: '', physicalDescription: '', portraitStyle: '', portraitImageUrl: '',
});

const formFromArtist = (a) => ({
  name: a.name || '',
  genre: a.genre || '',
  bio: a.bio || '',
  musicalStyle: a.musicalStyle || '',
  physicalDescription: a.physicalDescription || '',
  portraitStyle: a.portraitStyle || '',
  portraitImageUrl: a.portraitImageUrl || '',
});

// Build the image-gen prompt for an artist portrait from the persona's physical
// description (the subject) and portrait style (the art direction). Either field
// alone is enough to render; both are folded into one prompt.
const buildPortraitPrompt = (f) => {
  const desc = (f.physicalDescription || '').trim();
  const style = (f.portraitStyle || '').trim();
  const subject = desc ? `Music artist portrait. ${desc}` : 'Music artist promotional portrait.';
  return style ? `${subject} ${style}` : subject;
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

export default function ArtistsManager() {
  const navigate = useNavigate();
  // Selection lives in the URL (`/music/artists/:id`, `/music/artists/new`) so
  // it's deep-linkable and reload-safe. `id === 'new'` is create mode; a real id
  // is edit mode; absent is idle.
  const { id } = useParams();
  const [artists, setArtists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [uploadingPortrait, setUploadingPortrait] = useState(false);
  const [startingGen, setStartingGen] = useState(false);
  const [genJobId, setGenJobId] = useState(null);
  const fileInputRef = useRef(null);
  // Bumped on every artist switch / new-artist so a stale generate response
  // can't write the wrong persona's portrait (mirrors Authors' genRequestRef).
  const genRequestRef = useRef(0);

  const gen = useMediaJobProgress(genJobId);
  const isGenerating = startingGen || !!genJobId;

  const setPortrait = (url) => setForm((f) => ({ ...f, portraitImageUrl: url }));
  const clearGeneration = () => { genRequestRef.current += 1; setGenJobId(null); setStartingGen(false); };

  useEffect(() => {
    if (!genJobId) return;
    if (gen.status === 'completed' && gen.filename) {
      setPortrait(gen.path || `/data/images/${gen.filename}`);
      setGenJobId(null);
      toast.success('Portrait generated');
    } else if (gen.status === 'failed' || gen.status === 'canceled') {
      setGenJobId(null);
      toast.error(gen.error || 'Portrait generation failed');
    }
  }, [genJobId, gen.status, gen.filename, gen.path, gen.error]);

  const handleGeneratePortrait = async () => {
    if (isGenerating || uploadingPortrait) return;
    if (!form.physicalDescription.trim() && !form.portraitStyle.trim()) {
      toast.error('Add a physical description or portrait style to generate from');
      return;
    }
    const requestId = genRequestRef.current;
    setStartingGen(true);
    const queued = await generateImage({
      prompt: buildPortraitPrompt(form),
      negativePrompt: `${DEFAULT_NEGATIVE_PROMPT}, extra limbs, nsfw, nude`,
      width: 768,
      height: 1024,
    }, { silent: true }).catch((err) => ({ error: err }));
    if (genRequestRef.current !== requestId) return;
    setStartingGen(false);
    if (queued?.error) {
      toast.error(queued.error.message || 'Portrait generation failed');
      return;
    }
    if (queued.jobId) {
      setGenJobId(queued.jobId);
      toast.success('Generating portrait…');
      return;
    }
    const path = queued.path || (queued.filename ? `/data/images/${queued.filename}` : '');
    if (path) {
      setPortrait(path);
      toast.success('Portrait generated');
    } else {
      toast.error('Portrait generation returned no image');
    }
  };

  const handlePortraitFile = async (e) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Please choose an image file'); return; }
    if (file.size > PORTRAIT_MAX_BYTES) {
      toast.error(`Image exceeds ${Math.round(PORTRAIT_MAX_BYTES / 1024 / 1024)}MB`);
      return;
    }
    setUploadingPortrait(true);
    const base64 = await readFileAsBase64(file).catch(() => null);
    if (!base64) { setUploadingPortrait(false); toast.error('Could not read that file'); return; }
    // Route through the gallery (`/data/images/`) so the stored portrait URL
    // rides the image asset path (matches Authors' headshot upload).
    const uploaded = await uploadGalleryImage(base64, { silent: true }).catch((err) => {
      toast.error(err.message || 'Upload failed');
      return null;
    });
    setUploadingPortrait(false);
    if (uploaded?.path) {
      setPortrait(uploaded.path);
      toast.success('Portrait uploaded');
    }
  };

  const handlePortraitPick = (item) => {
    setGalleryOpen(false);
    const url = item?.previewUrl || (item?.filename ? `/data/images/${item.filename}` : '');
    if (url) setPortrait(url);
  };

  useEffect(() => {
    listArtists()
      .then((list) => setArtists(Array.isArray(list) ? list : []))
      .catch((err) => toast.error(err.message || 'Failed to load artists'))
      .finally(() => setLoading(false));
  }, []);

  const isCreate = id === 'new';
  const selected = useMemo(
    () => (isCreate || !id ? null : artists.find((a) => a.id === id) || null),
    [artists, id, isCreate],
  );
  const notFound = !isCreate && !!id && !loading && !selected;
  const canGenerate = !!(form.physicalDescription.trim() || form.portraitStyle.trim());

  const selectArtist = (a) => navigate(`/music/artists/${encodeURIComponent(a.id)}`);
  const startCreate = () => navigate('/music/artists/new');

  // Hydrate the editor form from the URL-selected artist. Keyed on the id so a
  // list refresh doesn't clobber the open form; resets run for every selection
  // change (incl. idle / not-found) so a stray render can't land on the previous
  // artist (see Authors.jsx for the base pattern).
  const hydratedRef = useRef(null);
  const selectionKey = id ?? null;
  useEffect(() => {
    if (loading) return;
    if (hydratedRef.current === selectionKey) return;
    hydratedRef.current = selectionKey;
    setConfirmDelete(false);
    clearGeneration();
    if (isCreate) setForm(emptyForm());
    else if (selected) setForm(formFromArtist(selected));
  }, [selectionKey, isCreate, selected, loading]);

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) { toast.error('Artist name is required'); return; }
    setSaving(true);
    const payload = { ...form, name };
    if (isCreate) {
      const created = await createArtist(payload).catch((err) => {
        toast.error(err.message || 'Failed to create artist');
        return null;
      });
      setSaving(false);
      if (!created) return;
      setArtists((prev) => [...prev, created].sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      navigate(`/music/artists/${encodeURIComponent(created.id)}`);
      toast.success(`Created "${created.name}"`);
    } else {
      const updated = await updateArtist(id, payload).catch((err) => {
        toast.error(err.message || 'Failed to save artist');
        return null;
      });
      setSaving(false);
      if (!updated) return;
      setArtists((prev) => prev
        .map((a) => (a.id === updated.id ? updated : a))
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      toast.success('Saved');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const prior = artists;
    setArtists((prev) => prev.filter((a) => a.id !== selected.id));
    setConfirmDelete(false);
    navigate('/music/artists');
    await deleteArtist(selected.id).catch((err) => {
      toast.error(err.message || 'Delete failed');
      setArtists(prior);
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <p className="text-sm text-gray-400 max-w-2xl">
          Artist personas are reusable across albums and tracks — the byline plus the genre, musical
          style, bio, and the physical description + style used to generate (or upload) an artist portrait.
        </p>
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium shrink-0"
        >
          <Plus size={16} aria-hidden="true" />
          New Artist
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        <div className="bg-port-card border border-port-border rounded-lg p-2">
          {loading ? (
            <div className="text-gray-500 text-sm p-2">Loading…</div>
          ) : artists.length === 0 ? (
            <div className="text-gray-500 text-sm p-2">No artists yet. Click <span className="text-port-accent">New Artist</span>.</div>
          ) : (
            <ul className="space-y-1">
              {artists.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => selectArtist(a)}
                    className={`w-full text-left px-3 py-2 rounded text-sm truncate ${
                      a.id === id ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-bg'
                    }`}
                  >
                    {a.name}
                    {a.genre ? <span className="block text-[11px] text-gray-500 truncate">{a.genre}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-4">
          {notFound ? (
            <div className="text-gray-500 text-sm">
              That artist could not be found — it may have been deleted.{' '}
              <button type="button" onClick={() => navigate('/music/artists')} className="text-port-accent hover:underline">
                Back to artists
              </button>
            </div>
          ) : !isCreate && !selected ? (
            <div className="text-gray-500 text-sm">Select an artist to edit, or create a new one.</div>
          ) : (
            <div className="space-y-3">
              <Field label="Name">
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Nova Vale"
                  maxLength={ARTIST_NAME_MAX}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                  autoFocus
                />
              </Field>
              <Field label="Genre" hint="Primary genre(s) — e.g. 'indie folk, dream pop'.">
                <input
                  value={form.genre}
                  onChange={(e) => setForm((f) => ({ ...f, genre: e.target.value }))}
                  placeholder="indie folk, dream pop"
                  maxLength={ARTIST_GENRE_MAX}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Musical style" hint="Voice / production / instrumentation notes — fed into music-gen prompts.">
                <textarea
                  value={form.musicalStyle}
                  onChange={(e) => setForm((f) => ({ ...f, musicalStyle: e.target.value }))}
                  rows={4}
                  maxLength={ARTIST_MUSICAL_STYLE_MAX}
                  placeholder="Warm fingerpicked guitar, breathy close-mic vocals, tape saturation, sparse reverb."
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Bio" hint="About-the-artist blurb.">
                <textarea
                  value={form.bio}
                  onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
                  rows={4}
                  maxLength={ARTIST_BIO_MAX}
                  placeholder="Nova Vale is a songwriter working at the seam of folk and ambient…"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Physical description" hint="Subject of the portrait — appearance, age, expression, wardrobe.">
                <textarea
                  value={form.physicalDescription}
                  onChange={(e) => setForm((f) => ({ ...f, physicalDescription: e.target.value }))}
                  rows={3}
                  maxLength={ARTIST_PHYSICAL_DESCRIPTION_MAX}
                  placeholder="Androgynous figure, late 20s, cropped platinum hair, vintage band tee, calm gaze."
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Portrait style" hint="Art / photography direction for the portrait render.">
                <textarea
                  value={form.portraitStyle}
                  onChange={(e) => setForm((f) => ({ ...f, portraitStyle: e.target.value }))}
                  rows={3}
                  maxLength={ARTIST_PORTRAIT_STYLE_MAX}
                  placeholder="Moody film photograph, neon backlight, grainy 35mm, shallow depth of field."
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Portrait image" hint="Optional — generate from the description + style, upload a photo, pick one from your gallery, or paste a URL.">
                <div className="flex items-start gap-3">
                  {isGenerating ? (
                    <div className="relative w-20 h-20 rounded border border-port-border bg-port-bg overflow-hidden flex items-center justify-center shrink-0">
                      {gen.currentImage ? (
                        <img
                          src={`data:image/png;base64,${gen.currentImage}`}
                          alt="Generating portrait preview"
                          className="w-full h-full object-cover opacity-70"
                        />
                      ) : (
                        <Loader2 size={20} className="animate-spin text-port-accent" aria-hidden="true" />
                      )}
                      {gen.totalSteps ? (
                        <div className="absolute bottom-0 inset-x-0 bg-black/60 text-[9px] text-white text-center py-0.5 font-mono">
                          {Math.round((gen.step / gen.totalSteps) * 100)}%
                        </div>
                      ) : null}
                    </div>
                  ) : form.portraitImageUrl ? (
                    <div className="relative shrink-0">
                      <img
                        src={form.portraitImageUrl}
                        alt="Artist portrait"
                        className="w-20 h-20 rounded object-cover border border-port-border bg-port-bg"
                      />
                      <button
                        type="button"
                        onClick={() => setPortrait('')}
                        title="Remove portrait"
                        className="absolute -top-2 -right-2 p-1 rounded-full bg-port-bg border border-port-border text-gray-400 hover:text-port-error"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="w-20 h-20 rounded border border-dashed border-port-border bg-port-bg flex items-center justify-center text-gray-600 shrink-0">
                      <ImageIcon size={20} aria-hidden="true" />
                    </div>
                  )}
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={handleGeneratePortrait}
                        disabled={isGenerating || uploadingPortrait || !canGenerate}
                        title={canGenerate
                          ? 'Generate a portrait from the description + style'
                          : 'Add a physical description or portrait style first'}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"
                      >
                        {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                        Generate
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingPortrait || isGenerating}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"
                      >
                        {uploadingPortrait ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                        Upload
                      </button>
                      <button
                        type="button"
                        onClick={() => setGalleryOpen(true)}
                        disabled={isGenerating}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"
                      >
                        <ImageIcon size={14} /> Choose from gallery
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handlePortraitFile}
                        className="hidden"
                      />
                    </div>
                    <input
                      value={form.portraitImageUrl}
                      onChange={(e) => setPortrait(e.target.value)}
                      disabled={isGenerating}
                      placeholder="/images/…  or  https://…"
                      maxLength={ARTIST_PORTRAIT_IMAGE_URL_MAX}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
                    />
                  </div>
                </div>
              </Field>

              <div className="flex items-center gap-2 pt-1 flex-wrap">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !form.name.trim()}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {isCreate ? 'Create' : 'Save'}
                </button>
                {!isCreate && selected ? (
                  confirmDelete ? (
                    <span className="inline-flex items-center gap-2 text-sm">
                      <span className="text-port-error">Delete this artist?</span>
                      <button type="button" onClick={handleDelete} className="px-2 py-1 rounded bg-port-error/20 text-port-error hover:bg-port-error/30">
                        Yes, delete
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1 rounded text-gray-400 hover:text-white">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-gray-400 hover:text-port-error text-sm"
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  )
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>

      <GalleryImagePicker
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        onSelect={handlePortraitPick}
      />
    </div>
  );
}
