/**
 * SongBook viewer — /songbook/:id.
 *
 * Full-bleed page (Layout.jsx isFullWidth matches /songbook/:id): flex-col
 * h-full shell with a shrink-0 header + controls bar and a flex-1
 * overflow-y-auto body the page owns (the autoscroll container).
 *
 * Two URL-param-driven modes (linkable-routes convention):
 * - PLAY (default): the rendered sheet (TabSheetView) with an
 *   Ultimate-Guitar-style controls bar — autoscroll play/pause + speed,
 *   transpose ± (render-time transposeText, never mutates stored text; offset
 *   persisted per song via safeStorage), font size ±, stage select, capo/key/
 *   tuning badges, source link — plus the attachments section (synced meta,
 *   machine-local bytes → "not on this machine" when absent).
 * - EDIT (?mode=edit): metadata form + font-mono content textarea with format
 *   select and live preview. Saves are explicit (single PUT). The whole
 *   `content` object is always sent — the server fills nested content
 *   defaults, so `{ content: { text } }` alone would reset format to 'tab'.
 *
 * Keyboard (play mode): space play/pause, +/- speed, [ ] transpose, 0 top.
 * A screen wake lock holds while autoscroll plays (useWakeLock).
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ListMusic, ArrowLeft, Save, Trash2, Pencil, Eye, Play, Pause, Plus, Minus,
  ExternalLink, Paperclip, Upload, FileX2,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import PageHeader from '../components/PageHeader';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import AutoSizeTextarea from '../components/ui/AutoSizeTextarea';
import TabSheetView from '../components/songbook/TabSheetView';
import {
  SONG_STAGES, SONG_STAGE_COLORS, INSTRUMENTS, SONG_FORMATS,
  inputClass, labelClass, btnClass,
} from '../components/songbook/constants';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import useDrawerTab from '../hooks/useDrawerTab';
import useKeyboardShortcuts from '../hooks/useKeyboardShortcuts';
import useAutoscroll from '../hooks/useAutoscroll';
import useWakeLock from '../hooks/useWakeLock';
import { transposeText } from '../lib/tabNotation.js';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage.js';
import { formatBytes } from '../utils/formatters';
import { isHttpUrl } from '../utils/urlNormalize';
import { readFileAsBase64 } from '../utils/fileUpload';
import {
  getSong, updateSong, deleteSong,
  listSongAttachments, uploadSongAttachment, deleteSongAttachment, songAttachmentUrl,
} from '../services/api';

// Mirrors MAX_ATTACHMENT_SIZE in server/routes/brainSongbook.js — 40MB, the
// largest raw payload that survives base64 ×4/3 inflation under the server's
// 55mb express.json limit. Deliberately NOT utils/fileUpload's
// ATTACHMENT_MAX_FILE_SIZE (50MB) — other surfaces still use that cap.
const SONGBOOK_MAX_FILE_SIZE = 40 * 1024 * 1024;

const TRANSPOSE_MIN = -11;
const TRANSPOSE_MAX = 11;
const FONT_MIN = 0.625;
const FONT_MAX = 1.75;
const FONT_STEP = 0.125;
const SPEED_MIN = 5;
const SPEED_MAX = 150;

// Song record → flat editable draft (tags joined for the text input).
const toDraft = (song) => ({
  title: song.title || '',
  artist: song.artist || '',
  instrument: song.instrument || 'guitar',
  stage: song.stage || 'new',
  key: song.key || '',
  capo: song.capo ?? 0,
  tuning: song.tuning || '',
  tags: Array.isArray(song.tags) ? song.tags.join(', ') : '',
  sourceUrl: song.sourceUrl || '',
  notes: song.notes || '',
  format: song.content?.format || 'tab',
  text: song.content?.text || '',
});

const parseTags = (raw) => raw.split(',').map((t) => t.trim()).filter(Boolean);

// 44px minimum touch targets on the controls bar (mobile-friendly).
const ctrlBtnClass = 'flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50';

export default function SongBookViewer() {
  const { id } = useParams();
  const navigate = useNavigate();
  // URL-backed mode (default 'play' omitted from the URL, replace-history writes).
  const [mode, setMode] = useDrawerTab('mode', 'play', ['play', 'edit']);
  const editing = mode === 'edit';

  const [song, setSong] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Bump to re-run the load effect (the Retry button on a non-404 failure).
  const [retryKey, setRetryKey] = useState(0);
  const [draft, setDraft] = useState(null);
  // null = not fetched yet, [] = fetched-and-empty (sentinel convention).
  const [attachments, setAttachments] = useState(null);
  // Once any attachment mutation has run, the (slow) initial list response is
  // stale — it must not clobber the optimistic upload/delete state.
  const attachmentsMutatedRef = useRef(false);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  useEffect(() => {
    let cancelled = false;
    setSong(null);
    setDraft(null);
    setAttachments(null);
    attachmentsMutatedRef.current = false;
    setNotFound(false);
    setLoadError(false);
    setLoading(true);
    getSong(id, { silent: true })
      .then((s) => {
        if (cancelled) return;
        setSong(s);
        setDraft(toDraft(s));
      })
      .catch((err) => {
        if (cancelled) return;
        // Only a genuine 404 means "not found" — anything else (network blip,
        // 5xx) gets a retryable load-error state instead of a lying fallback.
        if (err?.status === 404) setNotFound(true);
        else setLoadError(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    listSongAttachments(id, { silent: true })
      .then((list) => {
        if (!cancelled && !attachmentsMutatedRef.current) setAttachments(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled && !attachmentsMutatedRef.current) setAttachments([]);
      });
    return () => { cancelled = true; };
  }, [id, retryKey]);

  // --- Transpose: render-time only, persisted per song via safeStorage.
  const [transpose, setTransposeState] = useState(0);
  useEffect(() => {
    const n = Number(safeReadStorage(`songbook:transpose:${id}`));
    setTransposeState(Number.isFinite(n) ? Math.max(TRANSPOSE_MIN, Math.min(TRANSPOSE_MAX, Math.trunc(n))) : 0);
  }, [id]);
  const setTranspose = useCallback((n) => {
    const clamped = Math.max(TRANSPOSE_MIN, Math.min(TRANSPOSE_MAX, n));
    setTransposeState(clamped);
    safeWriteStorage(`songbook:transpose:${id}`, String(clamped));
  }, [id]);

  // --- Font size (rem scale), persisted globally — a comfortable reading size
  // carries across songs.
  const [fontSize, setFontSizeState] = useState(() => {
    const n = Number(safeReadStorage('songbook:fontSize'));
    return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n : 0.875;
  });
  const setFontSize = useCallback((n) => {
    const clamped = Math.max(FONT_MIN, Math.min(FONT_MAX, n));
    setFontSizeState(clamped);
    safeWriteStorage('songbook:fontSize', String(clamped));
  }, []);

  // --- Autoscroll + wake lock
  const scrollRef = useRef(null);
  const { playing, toggle, stop, pxPerSec, setPxPerSec } = useAutoscroll(scrollRef);
  useWakeLock(playing);

  const scrollToTop = useCallback(() => {
    stop();
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [stop]);

  useKeyboardShortcuts(!editing && !!song, {
    ' ': toggle,
    '+': () => setPxPerSec((v) => Math.min(SPEED_MAX, v + 5)),
    '=': () => setPxPerSec((v) => Math.min(SPEED_MAX, v + 5)),
    '-': () => setPxPerSec((v) => Math.max(SPEED_MIN, v - 5)),
    '[': () => setTranspose(transpose - 1),
    ']': () => setTranspose(transpose + 1),
    '0': scrollToTop,
  });

  // Keyed on the content STRING (not the song object) so unrelated record
  // updates (stage flips, attachment meta) don't re-run the transpose pass.
  const contentText = song?.content?.text || '';
  const renderedText = useMemo(
    () => (transpose ? transposeText(contentText, transpose) : contentText),
    [contentText, transpose],
  );

  // --- Mutations
  const onStageChange = useCallback((stage) => {
    // PUT just the stage (defaults-free partial). Helper toast owns the error
    // UI (no custom catch toast → no silent).
    updateSong(id, { stage })
      .then((updated) => {
        setSong(updated);
        setDraft((prev) => (prev ? { ...prev, stage: updated.stage } : prev));
      })
      .catch(() => {});
  }, [id]);

  const [save, saving] = useAsyncAction(async () => {
    const title = draft.title.trim();
    if (!title) { toast.error('Title is required'); return null; }
    const capo = Math.max(0, Math.min(12, Math.trunc(Number(draft.capo) || 0)));
    // Always the WHOLE content object — a partial { text } would reset format.
    const updated = await updateSong(id, {
      title,
      artist: draft.artist.trim(),
      instrument: draft.instrument,
      stage: draft.stage,
      key: draft.key.trim(),
      capo,
      tuning: draft.tuning.trim(),
      tags: parseTags(draft.tags),
      sourceUrl: draft.sourceUrl.trim(),
      notes: draft.notes,
      content: { format: draft.format, text: draft.text },
    }, { silent: true });
    setSong(updated);
    setDraft(toDraft(updated));
    toast.success('Song saved');
    return updated;
  }, { errorMessage: 'Failed to save song' });

  const onDeleteSong = useCallback(() => confirmDelete(() =>
    deleteSong(id, { silent: true })
      .then(() => navigate('/songbook'))
      .catch((err) => toast.error(err?.message || 'Failed to delete song')),
  ), [confirmDelete, id, navigate]);

  // --- Attachments
  const fileInputRef = useRef(null);
  const [uploadFiles, uploading] = useAsyncAction(async (files) => {
    for (const file of Array.from(files)) {
      if (file.size > SONGBOOK_MAX_FILE_SIZE) {
        toast.error(`"${file.name}" exceeds ${Math.round(SONGBOOK_MAX_FILE_SIZE / 1024 / 1024)}MB limit`);
        continue;
      }
      const data = await readFileAsBase64(file);
      const res = await uploadSongAttachment(id, { filename: file.name, data }, { silent: true });
      if (res?.attachment) {
        attachmentsMutatedRef.current = true;
        setAttachments((prev) => [...(prev || []), { ...res.attachment, present: true }]);
      }
    }
  }, { errorMessage: 'Upload failed' });

  const onDeleteAttachment = useCallback((filename) => confirmDelete(() =>
    deleteSongAttachment(id, filename, { silent: true })
      .then((res) => {
        attachmentsMutatedRef.current = true;
        // Server returns the updated meta list; carry over local present flags.
        setAttachments((prev) => (res?.attachments || []).map((meta) => ({
          ...meta,
          present: prev?.find((a) => a.filename === meta.filename)?.present ?? false,
        })));
      })
      .catch((err) => toast.error(err?.message || 'Failed to delete attachment')),
  ), [confirmDelete, id]);

  // --- Render states
  if (notFound) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-center p-6">
        <ListMusic size={32} className="text-gray-600 mb-3" />
        <h2 className="text-white font-semibold mb-1">Song not found</h2>
        <p className="text-gray-400 text-sm mb-4">It may have been deleted, or the link is stale.</p>
        <Link to="/songbook" className="px-4 py-2 rounded-lg text-sm bg-port-accent/10 text-port-accent hover:bg-port-accent/20">
          Back to SongBook
        </Link>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-center p-6">
        <ListMusic size={32} className="text-gray-600 mb-3" />
        <h2 className="text-white font-semibold mb-1">Couldn't load this song</h2>
        <p className="text-gray-400 text-sm mb-4">Something went wrong fetching it — the song may still exist.</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setRetryKey((k) => k + 1)}
            className="px-4 py-2 rounded-lg text-sm bg-port-accent text-white hover:bg-port-accent/90"
          >
            Retry
          </button>
          <Link to="/songbook" className="px-4 py-2 rounded-lg text-sm bg-port-accent/10 text-port-accent hover:bg-port-accent/20">
            Back to SongBook
          </Link>
        </div>
      </div>
    );
  }

  if (loading || !song) {
    return <p className="p-6 text-sm text-gray-500">Loading song…</p>;
  }

  const stageClass = SONG_STAGE_COLORS[song.stage] || SONG_STAGE_COLORS.new;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={ListMusic}
        title={song.title}
        subtitle={song.artist || undefined}
        actions={(
          <>
            <Link to="/songbook" className={btnClass}>
              <ArrowLeft size={15} />
              <span className="hidden sm:inline">All songs</span>
            </Link>
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={() => save()}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
                >
                  <Save size={15} />
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('play')}
                  className={btnClass}
                >
                  <Eye size={15} />
                  View
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setMode('edit')}
                className={btnClass}
              >
                <Pencil size={15} />
                Edit
              </button>
            )}
            {isConfirming('song') ? (
              <ConfirmButtonPair
                prompt="Delete?"
                ariaLabel={`Confirm delete ${song.title}`}
                onConfirm={onDeleteSong}
                onCancel={cancelDelete}
              />
            ) : (
              <button
                type="button"
                onClick={() => requestDelete('song')}
                className="p-2 text-gray-500 hover:text-port-error"
                aria-label={`Delete ${song.title}`}
                title="Delete song"
              >
                <Trash2 size={16} />
              </button>
            )}
          </>
        )}
      />

      {editing ? (
        /* ============================== EDIT MODE ============================== */
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <div>
              <label htmlFor="song-edit-title" className={labelClass}>Title</label>
              <input id="song-edit-title" type="text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label htmlFor="song-edit-artist" className={labelClass}>Artist</label>
              <input id="song-edit-artist" type="text" value={draft.artist} onChange={(e) => setDraft({ ...draft, artist: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label htmlFor="song-edit-instrument" className={labelClass}>Instrument</label>
              <select id="song-edit-instrument" value={draft.instrument} onChange={(e) => setDraft({ ...draft, instrument: e.target.value })} className={inputClass}>
                {INSTRUMENTS.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="song-edit-stage" className={labelClass}>Stage</label>
              <select id="song-edit-stage" value={draft.stage} onChange={(e) => setDraft({ ...draft, stage: e.target.value })} className={inputClass}>
                {SONG_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="song-edit-key" className={labelClass}>Key</label>
              <input id="song-edit-key" type="text" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} placeholder="e.g. Am" className={inputClass} />
            </div>
            <div>
              <label htmlFor="song-edit-capo" className={labelClass}>Capo</label>
              <input id="song-edit-capo" type="number" min="0" max="12" value={draft.capo} onChange={(e) => setDraft({ ...draft, capo: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label htmlFor="song-edit-tuning" className={labelClass}>Tuning</label>
              <input id="song-edit-tuning" type="text" value={draft.tuning} onChange={(e) => setDraft({ ...draft, tuning: e.target.value })} placeholder="e.g. Drop D" className={inputClass} />
            </div>
            <div>
              <label htmlFor="song-edit-tags" className={labelClass}>Tags (comma-separated)</label>
              <input id="song-edit-tags" type="text" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="e.g. campfire, fingerstyle" className={inputClass} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="song-edit-source" className={labelClass}>Source URL</label>
              <input id="song-edit-source" type="text" value={draft.sourceUrl} onChange={(e) => setDraft({ ...draft, sourceUrl: e.target.value })} placeholder="https://…" className={inputClass} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="song-edit-notes" className={labelClass}>Notes</label>
              <AutoSizeTextarea
                id="song-edit-notes"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                placeholder="Practice notes, tricky passages…"
                className={`${inputClass} min-h-[42px]`}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="song-edit-text" className="text-xs text-gray-400">Content</label>
                <div className="flex items-center gap-2">
                  <label htmlFor="song-edit-format" className="text-xs text-gray-500">Format</label>
                  <select
                    id="song-edit-format"
                    value={draft.format}
                    onChange={(e) => setDraft({ ...draft, format: e.target.value })}
                    className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:border-port-accent focus:outline-none"
                  >
                    {SONG_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
              </div>
              <AutoSizeTextarea
                id="song-edit-text"
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                placeholder={'[Verse 1]\nC        G\nExample lyrics here…'}
                spellCheck={false}
                className={`${inputClass} font-mono min-h-[280px] whitespace-pre`}
              />
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-1">Preview</div>
              <div className="bg-port-card border border-port-border rounded-lg p-3 overflow-x-auto">
                <TabSheetView text={draft.text} format={draft.format} fontSizeRem={fontSize} />
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ============================== PLAY MODE ============================== */
        <>
          <div className="shrink-0 border-b border-port-border bg-port-card/60 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* Autoscroll */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggle}
                className={`${ctrlBtnClass} ${playing ? 'text-port-accent border-port-accent/50' : ''}`}
                aria-label={playing ? 'Pause autoscroll' : 'Play autoscroll'}
                title={playing ? 'Pause autoscroll (space)' : 'Play autoscroll (space)'}
              >
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <label htmlFor="song-speed" className="sr-only">Autoscroll speed</label>
              <input
                id="song-speed"
                type="range"
                min={SPEED_MIN}
                max={SPEED_MAX}
                value={pxPerSec}
                onChange={(e) => setPxPerSec(Number(e.target.value))}
                className="w-24 sm:w-32 accent-port-accent"
                title="Autoscroll speed (+/-)"
              />
            </div>

            {/* Transpose */}
            <div className="flex items-center gap-1" role="group" aria-label="Transpose">
              <button type="button" onClick={() => setTranspose(transpose - 1)} className={ctrlBtnClass} aria-label="Transpose down" title="Transpose down ([)">
                <Minus size={16} />
              </button>
              <span className="min-w-[3.5rem] text-center text-sm text-gray-300 font-mono" title="Transpose (semitones)">
                {transpose > 0 ? `+${transpose}` : transpose}
              </span>
              <button type="button" onClick={() => setTranspose(transpose + 1)} className={ctrlBtnClass} aria-label="Transpose up" title="Transpose up (])">
                <Plus size={16} />
              </button>
            </div>

            {/* Font size */}
            <div className="flex items-center gap-1" role="group" aria-label="Font size">
              <button type="button" onClick={() => setFontSize(fontSize - FONT_STEP)} className={`${ctrlBtnClass} text-xs font-bold`} aria-label="Smaller text">
                A−
              </button>
              <button type="button" onClick={() => setFontSize(fontSize + FONT_STEP)} className={`${ctrlBtnClass} text-sm font-bold`} aria-label="Larger text">
                A+
              </button>
            </div>

            {/* Stage */}
            <div>
              <label htmlFor="song-stage" className="sr-only">Learning stage</label>
              <select
                id="song-stage"
                value={song.stage || 'new'}
                onChange={(e) => onStageChange(e.target.value)}
                className={`text-xs rounded-full border px-2 py-2 min-h-[44px] focus:outline-none ${stageClass}`}
              >
                {SONG_STAGES.map((s) => <option key={s.id} value={s.id} className="bg-port-card text-white">{s.label}</option>)}
              </select>
            </div>

            {/* Badges + source */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400 ml-auto">
              {song.key && <span className="px-2 py-1 rounded-full bg-port-bg border border-port-border">Key {song.key}</span>}
              {song.capo > 0 && <span className="px-2 py-1 rounded-full bg-port-bg border border-port-border">Capo {song.capo}</span>}
              {song.tuning && <span className="px-2 py-1 rounded-full bg-port-bg border border-port-border">{song.tuning}</span>}
              {isHttpUrl(song.sourceUrl) && (
                <a
                  href={song.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 px-2 py-1 rounded-full bg-port-bg border border-port-border text-port-accent hover:border-port-accent/50"
                >
                  <ExternalLink size={12} />
                  Source
                </a>
              )}
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
            {song.content?.text ? (
              <TabSheetView
                text={renderedText}
                format={song?.content?.format || 'tab'}
                fontSizeRem={fontSize}
                className="max-w-4xl"
              />
            ) : (
              <p className="text-sm text-gray-500">
                No sheet content yet — <button type="button" onClick={() => setMode('edit')} className="text-port-accent hover:underline">add some in Edit mode</button>.
              </p>
            )}

            {song.notes && (
              <div className="mt-6 max-w-4xl text-sm text-gray-400 whitespace-pre-wrap border-t border-port-border pt-3">
                {song.notes}
              </div>
            )}

            {/* Attachments */}
            <div className="mt-8 max-w-4xl border-t border-port-border pt-4 pb-16">
              <div className="flex items-center justify-between mb-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Paperclip size={14} className="text-gray-500" />
                  Attachments
                </h2>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    aria-label="Upload attachment"
                    onChange={(e) => { if (e.target.files?.length) uploadFiles(e.target.files); e.target.value = ''; }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
                  >
                    <Upload size={13} />
                    {uploading ? 'Uploading…' : 'Upload'}
                  </button>
                </div>
              </div>
              {attachments === null ? (
                <p className="text-xs text-gray-500">Loading attachments…</p>
              ) : attachments.length === 0 ? (
                <p className="text-xs text-gray-500">No attachments — upload sheet-music PDFs, images, or MIDI files.</p>
              ) : (
                <ul className="space-y-1">
                  {attachments.map((att) => (
                    <li key={att.filename} className="flex items-center gap-3 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm">
                      {att.present ? (
                        <a
                          href={songAttachmentUrl(id, att.filename)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 min-w-0 truncate text-port-accent hover:underline"
                          title={att.label || att.filename}
                        >
                          {att.label || att.filename}
                        </a>
                      ) : (
                        <span className="flex-1 min-w-0 flex items-center gap-2 truncate text-gray-500" title={att.label || att.filename}>
                          <FileX2 size={13} className="shrink-0" />
                          <span className="truncate">{att.label || att.filename}</span>
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-600 border border-port-border rounded-full px-1.5 py-0.5">not on this machine</span>
                        </span>
                      )}
                      {att.size != null && <span className="shrink-0 text-xs text-gray-500">{formatBytes(att.size)}</span>}
                      {isConfirming(att.filename) ? (
                        <ConfirmButtonPair
                          prompt="Delete?"
                          className="shrink-0"
                          ariaLabel={`Confirm delete ${att.label || att.filename}`}
                          onConfirm={() => onDeleteAttachment(att.filename)}
                          onCancel={cancelDelete}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => requestDelete(att.filename)}
                          className="p-1.5 shrink-0 text-gray-500 hover:text-port-error"
                          aria-label={`Delete attachment ${att.label || att.filename}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
