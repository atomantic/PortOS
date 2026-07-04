/**
 * Authors page — manage reusable author personas.
 *
 * An Author is a creative persona used as a series' cover byline and as the
 * prompt source for a book-cover author headshot. Each carries a name, writing
 * style, bio, a physical description + style direction for the headshot, and an
 * optional headshot image pointer.
 *
 * Master-detail: a selectable list on the left, an editor on the right. Picking
 * an author loads it into the editor; "New Author" opens a blank create form.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FilePen, Plus, Loader2, Trash2, Save, Upload, ImageIcon, Sparkles, X } from 'lucide-react';
import toast from '../components/ui/Toast';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import useMediaJobProgress from '../hooks/useMediaJobProgress';
import { DEFAULT_NEGATIVE_PROMPT } from '../lib/imageGenDefaults';
import { readFileAsBase64 } from '../utils/fileUpload';
import {
  listAuthors, createAuthor, updateAuthor, deleteAuthor, uploadGalleryImage, generateImage,
  AUTHOR_NAME_MAX, AUTHOR_WRITING_STYLE_MAX, AUTHOR_BIO_MAX,
  AUTHOR_PHYSICAL_DESCRIPTION_MAX, AUTHOR_HEADSHOT_STYLE_MAX, AUTHOR_HEADSHOT_IMAGE_URL_MAX,
} from '../services/api';

// Cap headshot uploads so the base64 round-trip stays small — a cover headshot
// never needs more than a few MB.
const HEADSHOT_MAX_BYTES = 12 * 1024 * 1024;

const emptyForm = () => ({
  name: '', writingStyle: '', bio: '', physicalDescription: '', headshotStyle: '', headshotImageUrl: '',
});

const formFromAuthor = (a) => ({
  name: a.name || '',
  writingStyle: a.writingStyle || '',
  bio: a.bio || '',
  physicalDescription: a.physicalDescription || '',
  headshotStyle: a.headshotStyle || '',
  headshotImageUrl: a.headshotImageUrl || '',
});

// Build the image-gen prompt for an author headshot from the persona's
// physical description (the subject) and headshot style (the art direction).
// Either field alone is enough to render; both are folded into one prompt.
const buildHeadshotPrompt = (f) => {
  const desc = (f.physicalDescription || '').trim();
  const style = (f.headshotStyle || '').trim();
  const subject = desc ? `Author headshot portrait. ${desc}` : 'Professional author headshot portrait.';
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

export default function Authors() {
  const navigate = useNavigate();
  // Selection lives in the URL (`/authors/:authorId`, `/authors/new`) so it's
  // deep-linkable, reload-safe, and reachable from ⌘K/voice. `authorId === 'new'`
  // is create mode; a real id is edit mode; absent is idle.
  const { authorId } = useParams();
  const [authors, setAuthors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [uploadingHeadshot, setUploadingHeadshot] = useState(false);
  // Headshot generation: `startingGen` covers the request round-trip before a
  // jobId exists; `genJobId` tracks an async (local/codex) render until it
  // completes. External SD-API renders synchronously and never sets genJobId.
  const [startingGen, setStartingGen] = useState(false);
  const [genJobId, setGenJobId] = useState(null);
  const fileInputRef = useRef(null);
  // Bumped on every author switch / new-author. A generate request captures
  // this before its POST and bails if it changed by the time the POST resolves
  // — closes the pre-jobId round-trip window where `clearGeneration` alone
  // can't stop a stale response from writing the wrong persona's headshot.
  const genRequestRef = useRef(0);

  const gen = useMediaJobProgress(genJobId);
  const isGenerating = startingGen || !!genJobId;

  const setHeadshot = (url) => setForm((f) => ({ ...f, headshotImageUrl: url }));
  // Drop any in-flight render so its completion can't write the wrong author.
  const clearGeneration = () => { genRequestRef.current += 1; setGenJobId(null); setStartingGen(false); };

  // Land the finished async render into the form, or surface a failure. Cleared
  // genJobId on author switch (see selectAuthor/startCreate) prevents a stale
  // render from writing the wrong author's headshot.
  useEffect(() => {
    if (!genJobId) return;
    if (gen.status === 'completed' && gen.filename) {
      setHeadshot(gen.path || `/data/images/${gen.filename}`);
      setGenJobId(null);
      toast.success('Headshot generated');
    } else if (gen.status === 'failed' || gen.status === 'canceled') {
      setGenJobId(null);
      toast.error(gen.error || 'Headshot generation failed');
    }
  }, [genJobId, gen.status, gen.filename, gen.path, gen.error]);

  const handleGenerateHeadshot = async () => {
    if (isGenerating || uploadingHeadshot) return;
    if (!form.physicalDescription.trim() && !form.headshotStyle.trim()) {
      toast.error('Add a physical description or headshot style to generate from');
      return;
    }
    const requestId = genRequestRef.current;
    setStartingGen(true);
    // `silent: true` — this catch owns the error toast, so suppress the
    // apiCore `request()` helper's default toast to avoid firing two.
    const queued = await generateImage({
      prompt: buildHeadshotPrompt(form),
      // Shared base plus portrait-specific guards (people-only artifacts).
      negativePrompt: `${DEFAULT_NEGATIVE_PROMPT}, extra limbs, nsfw, nude`,
      width: 768,
      height: 1024,
    }, { silent: true }).catch((err) => ({ error: err }));
    // Superseded by an author switch during the POST round-trip — clearGeneration
    // already reset state; drop this response so it can't land on the new author.
    if (genRequestRef.current !== requestId) return;
    setStartingGen(false);
    if (queued?.error) {
      toast.error(queued.error.message || 'Headshot generation failed');
      return;
    }
    if (queued.jobId) {
      // Async backend — track progress until the job completes.
      setGenJobId(queued.jobId);
      toast.success('Generating headshot…');
      return;
    }
    // Synchronous backend (external SD-API) returns the finished image directly.
    const path = queued.path || (queued.filename ? `/data/images/${queued.filename}` : '');
    if (path) {
      setHeadshot(path);
      toast.success('Headshot generated');
    } else {
      toast.error('Headshot generation returned no image');
    }
  };

  const handleHeadshotFile = async (e) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Please choose an image file'); return; }
    if (file.size > HEADSHOT_MAX_BYTES) {
      toast.error(`Image exceeds ${Math.round(HEADSHOT_MAX_BYTES / 1024 / 1024)}MB`);
      return;
    }
    setUploadingHeadshot(true);
    const base64 = await readFileAsBase64(file).catch(() => null);
    if (!base64) { setUploadingHeadshot(false); toast.error('Could not read that file'); return; }
    // Route through the gallery (`/data/images/`) — NOT the generic /uploads
    // path — so the stored headshot URL rides the `image` peer-sync asset path
    // and the bytes actually transfer to federated peers (issue #1327).
    const uploaded = await uploadGalleryImage(base64, { silent: true }).catch((err) => {
      toast.error(err.message || 'Upload failed');
      return null;
    });
    setUploadingHeadshot(false);
    if (uploaded?.path) {
      setHeadshot(uploaded.path);
      toast.success('Headshot uploaded');
    }
  };

  const handleHeadshotPick = (item) => {
    setGalleryOpen(false);
    const url = item?.previewUrl || (item?.filename ? `/data/images/${item.filename}` : '');
    if (url) setHeadshot(url);
  };

  useEffect(() => {
    listAuthors()
      .then((list) => setAuthors(Array.isArray(list) ? list : []))
      .catch((err) => toast.error(err.message || 'Failed to load authors'))
      .finally(() => setLoading(false));
  }, []);

  const isCreate = authorId === 'new';
  const selected = useMemo(
    () => (isCreate || !authorId ? null : authors.find((a) => a.id === authorId) || null),
    [authors, authorId, isCreate],
  );
  // A real id that isn't in the loaded list (deleted / bad deep link) → not-found.
  const notFound = !isCreate && !!authorId && !loading && !selected;
  // A headshot render needs at least a subject or an art-direction prompt.
  const canGenerate = !!(form.physicalDescription.trim() || form.headshotStyle.trim());

  const selectAuthor = (a) => navigate(`/authors/${encodeURIComponent(a.id)}`);
  const startCreate = () => navigate('/authors/new');

  // Hydrate the editor form from the URL-selected author. Keyed on the id so a
  // list refresh (create/update/delete mutating `authors`) doesn't clobber the
  // open form; `hydratedRef` tracks which selection is already loaded. Resets
  // (confirm-delete + any in-flight generation) run for EVERY selection change —
  // including navigating to the idle index or a stale id — so a stray render
  // can't land on the previous author after you've moved on.
  const hydratedRef = useRef(null);
  const selectionKey = authorId ?? null;
  useEffect(() => {
    if (loading) return;
    if (hydratedRef.current === selectionKey) return;
    hydratedRef.current = selectionKey;
    setConfirmDelete(false);
    clearGeneration();
    if (isCreate) setForm(emptyForm());
    else if (selected) setForm(formFromAuthor(selected));
    // else: idle / not-found — leave the form; the fallback UI handles it.
  }, [selectionKey, isCreate, selected, loading]);

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) { toast.error('Author name is required'); return; }
    setSaving(true);
    const payload = { ...form, name };
    if (isCreate) {
      const created = await createAuthor(payload).catch((err) => {
        toast.error(err.message || 'Failed to create author');
        return null;
      });
      setSaving(false);
      if (!created) return;
      setAuthors((prev) => [...prev, created].sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      navigate(`/authors/${encodeURIComponent(created.id)}`);
      toast.success(`Created "${created.name}"`);
    } else {
      const updated = await updateAuthor(authorId, payload).catch((err) => {
        toast.error(err.message || 'Failed to save author');
        return null;
      });
      setSaving(false);
      if (!updated) return;
      setAuthors((prev) => prev
        .map((a) => (a.id === updated.id ? updated : a))
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      toast.success('Saved');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const prior = authors;
    setAuthors((prev) => prev.filter((a) => a.id !== selected.id));
    setConfirmDelete(false);
    navigate('/authors');
    await deleteAuthor(selected.id).catch((err) => {
      toast.error(err.message || 'Delete failed');
      setAuthors(prior);
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <FilePen className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Authors</h1>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
        >
          <Plus size={16} aria-hidden="true" />
          New Author
        </button>
      </div>

      <p className="text-sm text-gray-400 mb-6">
        Author personas are reusable across series — the cover byline plus the writing voice, bio, and the
        physical description + style used to generate a book-cover author headshot. Link one to a series from
        the Series Pipeline.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        <div className="bg-port-card border border-port-border rounded-lg p-2">
          {loading ? (
            <div className="text-gray-500 text-sm p-2">Loading…</div>
          ) : authors.length === 0 ? (
            <div className="text-gray-500 text-sm p-2">No authors yet. Click <span className="text-port-accent">New Author</span>.</div>
          ) : (
            <ul className="space-y-1">
              {authors.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => selectAuthor(a)}
                    className={`w-full text-left px-3 py-2 rounded text-sm truncate ${
                      a.id === authorId ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-bg'
                    }`}
                  >
                    {a.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-4">
          {notFound ? (
            <div className="text-gray-500 text-sm">
              That author could not be found — it may have been deleted.{' '}
              <button type="button" onClick={() => navigate('/authors')} className="text-port-accent hover:underline">
                Back to authors
              </button>
            </div>
          ) : !isCreate && !selected ? (
            <div className="text-gray-500 text-sm">Select an author to edit, or create a new one.</div>
          ) : (
            <div className="space-y-3">
              <Field label="Name">
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Jane Doe"
                  maxLength={AUTHOR_NAME_MAX}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                  autoFocus
                />
              </Field>
              <Field label="Writing style" hint="Voice / tone / craft notes — fed into stage prompts.">
                <textarea
                  value={form.writingStyle}
                  onChange={(e) => setForm((f) => ({ ...f, writingStyle: e.target.value }))}
                  rows={4}
                  maxLength={AUTHOR_WRITING_STYLE_MAX}
                  placeholder="Spare, noir-tinged prose; short declarative sentences; dry wit."
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Bio" hint="About-the-author blurb for the back cover.">
                <textarea
                  value={form.bio}
                  onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
                  rows={4}
                  maxLength={AUTHOR_BIO_MAX}
                  placeholder="Jane Doe is the author of…"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Physical description" hint="Subject of the cover headshot — appearance, age, expression.">
                <textarea
                  value={form.physicalDescription}
                  onChange={(e) => setForm((f) => ({ ...f, physicalDescription: e.target.value }))}
                  rows={3}
                  maxLength={AUTHOR_PHYSICAL_DESCRIPTION_MAX}
                  placeholder="Woman in her 40s, silver-streaked dark hair, warm gaze, slight smile."
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Headshot style" hint="Art / photography direction for the headshot render.">
                <textarea
                  value={form.headshotStyle}
                  onChange={(e) => setForm((f) => ({ ...f, headshotStyle: e.target.value }))}
                  rows={3}
                  maxLength={AUTHOR_HEADSHOT_STYLE_MAX}
                  placeholder="Studio portrait, soft Rembrandt lighting, muted background, 85mm."
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </Field>
              <Field label="Headshot image" hint="Optional — generate from the description + style, upload a photo, pick one from your gallery, or paste a URL. Used on covers.">
                <div className="flex items-start gap-3">
                  {isGenerating ? (
                    <div className="relative w-20 h-20 rounded border border-port-border bg-port-bg overflow-hidden flex items-center justify-center shrink-0">
                      {gen.currentImage ? (
                        <img
                          src={`data:image/png;base64,${gen.currentImage}`}
                          alt="Generating headshot preview"
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
                  ) : form.headshotImageUrl ? (
                    <div className="relative shrink-0">
                      <img
                        src={form.headshotImageUrl}
                        alt="Author headshot"
                        className="w-20 h-20 rounded object-cover border border-port-border bg-port-bg"
                      />
                      <button
                        type="button"
                        onClick={() => setHeadshot('')}
                        title="Remove headshot"
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
                        onClick={handleGenerateHeadshot}
                        disabled={isGenerating || uploadingHeadshot || !canGenerate}
                        title={canGenerate
                          ? 'Generate a headshot from the description + style'
                          : 'Add a physical description or headshot style first'}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"
                      >
                        {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                        Generate
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingHeadshot || isGenerating}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"
                      >
                        {uploadingHeadshot ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
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
                        onChange={handleHeadshotFile}
                        className="hidden"
                      />
                    </div>
                    <input
                      value={form.headshotImageUrl}
                      onChange={(e) => setHeadshot(e.target.value)}
                      disabled={isGenerating}
                      placeholder="/images/…  or  https://…"
                      maxLength={AUTHOR_HEADSHOT_IMAGE_URL_MAX}
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
                      <span className="text-port-error">Delete this author?</span>
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
        onSelect={handleHeadshotPick}
      />
    </div>
  );
}
