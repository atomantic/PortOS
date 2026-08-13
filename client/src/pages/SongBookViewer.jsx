/**
 * SongBook viewer — /songbook/:id.
 *
 * Full-bleed page (Layout.jsx isFullWidth matches /songbook/:id): flex-col
 * h-full shell with a shrink-0 header + controls bar and a flex-1
 * overflow-y-auto body the page owns (the autoscroll container).
 *
 * Two URL-param-driven modes (linkable-routes convention):
 * - PLAY (default): the rendered sheet (TabSheetView — or DrumSheetView plus a
 *   drum transport bar when the content format is `drum`, #3115) with an
 *   Ultimate-Guitar-style controls bar — autoscroll play/pause + speed
 *   (suppressed for a drum chart, which scrolls itself horizontally under its
 *   own playhead and would otherwise carry two rival "play" buttons),
 *   transpose ± (render-time transposeText, never mutates stored text; offset
 *   persisted per song via safeStorage), font size ±, an instrument-view
 *   toggle (?view=guitar|ukulele|piano — chord diagrams only, render-only,
 *   defaults to the song's instrument), stage select, capo/key/tuning badges,
 *   source link — plus the attachments section (synced meta, machine-local
 *   bytes → "not on this machine" when absent).
 * - EDIT (?mode=edit): metadata form + font-mono content textarea with format
 *   select and live preview. Saves are explicit (single PATCH). The whole
 *   `content` object is always sent — the server fills nested content
 *   defaults, so `{ content: { text } }` alone would reset format to 'tab'.
 *   Because the draft only reaches the server on Save, every exit out of edit
 *   mode (View toggle, "All songs", tab close) goes through an unsaved-changes
 *   guard rather than dropping the draft silently (#3902).
 *
 * Keyboard (play mode): space play/pause, +/- speed, [ ] transpose, 0 top.
 * For a drum chart the same keys drive the kit transport instead: space
 * play/stop, +/- BPM ±1, [ ] set the loop ends at the current bar.
 * A screen wake lock holds while autoscroll plays — or while the kit plays
 * (useWakeLock).
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  ListMusic, ArrowLeft, Save, Trash2, Pencil, Eye, Play, Pause, Plus, Minus,
  ExternalLink, Paperclip, Upload, FileX2,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import FilePickerButton from '../components/ui/FilePickerButton';
import PageHeader from '../components/PageHeader';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import AutoSizeTextarea from '../components/ui/AutoSizeTextarea';
import TabPills from '../components/ui/TabPills';
import TabSheetView from '../components/songbook/TabSheetView';
import DrumSheetView from '../components/songbook/DrumSheetView';
import DrumPreview from '../components/songbook/DrumPreview';
import DrumTransportBar from '../components/songbook/DrumTransportBar';
import {
  SONG_STAGES, SONG_STAGE_COLORS, INSTRUMENTS, SONG_FORMATS, DRUM_FORMAT,
  DRUM_INSTRUMENT, withStoredOption,
  inputClass, labelClass, btnClass, instrumentLabel,
} from '../components/songbook/constants';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import useDrawerTab from '../hooks/useDrawerTab';
import useKeyboardShortcuts from '../hooks/useKeyboardShortcuts';
import useAutoscroll from '../hooks/useAutoscroll';
import useDrumPlayer from '../hooks/useDrumPlayer';
import useWakeLock from '../hooks/useWakeLock';
import { transposeText } from '../lib/tabNotation.js';
import { VOICING_INSTRUMENTS, toVoicingInstrument } from '../lib/chordShapes.js';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage.js';
import { formatBytes } from '../utils/formatters';
import { isHttpUrl } from '../utils/urlNormalize';
import { readFileAsBase64, JSON_UPLOAD_MAX_FILE_SIZE } from '../utils/fileUpload';
import {
  getSong, updateSong, deleteSong,
  listSongAttachments, uploadSongAttachment, deleteSongAttachment, songAttachmentUrl,
} from '../services/api';

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

// Draft-vs-saved comparison for the unsaved-changes guard. Both sides come from
// toDraft (flat strings), except `capo`: the number input hands back a STRING,
// so retyping the stored value ('2' vs 2) would otherwise read as an edit. An
// emptied capo field compares as 0, which is what the save would clamp it to.
const draftsEqual = (a, b) => Object.keys(a).every((k) => (
  k === 'capo' ? Number(a.capo || 0) === Number(b.capo || 0) : a[k] === b[k]
));

// Instrument-view toggle tabs (chord-diagram rendering — never mutates the record).
const VIEW_TABS = VOICING_INSTRUMENTS.map((viewId) => ({ id: viewId, label: instrumentLabel(viewId) }));

// Worked example in the editor's placeholder — the grid DSL is easier to copy
// than to describe. Invented groove (privacy convention).
const DRUM_PLACEHOLDER = [
  'time: 4/4', 'tempo: 96', 'subdivision: 4', '',
  '# Bar 1 — basic rock beat', 'HH: x x x x x x x x', 'S:  - - - - o - - -', 'K:  o - - - - - o -',
].join('\n');

// 44px minimum touch targets on the controls bar (mobile-friendly).
const ctrlBtnClass = 'flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50';

export default function SongBookViewer() {
  const { id } = useParams();
  const navigate = useNavigate();
  // URL-backed mode (default 'play' omitted from the URL, replace-history writes).
  const [mode, setMode] = useDrawerTab('mode', 'play', ['play', 'edit']);
  const editing = mode === 'edit';

  const [song, setSong] = useState(null);
  // URL-backed instrument view (?view=guitar|ukulele|piano). Render-only —
  // never PATCHed back to the record. Defaults to the song's own instrument
  // (bass/voice/other map to guitar), so the param stays off the URL for the
  // song's natural view and deep links like ?view=piano stay shareable.
  const [instrumentView, setInstrumentView] = useDrawerTab(
    'view',
    toVoicingInstrument(song?.instrument),
    VOICING_INSTRUMENTS,
  );
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Bump to re-run the load effect (the Retry button on a non-404 failure).
  const [retryKey, setRetryKey] = useState(0);
  const [draft, setDraft] = useState(null);
  // null = not fetched yet, [] = fetched-and-empty (sentinel convention).
  // 'failed' = presence lookup errored (presence unknown, list still shown).
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
        // Presence lookup failed — don't render "no attachments" over synced
        // metadata that exists. Fall back to the record's own list with
        // presence unknown (no "not on this machine" pill either way).
        if (!cancelled && !attachmentsMutatedRef.current) setAttachments('failed');
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

  // Presence lookup failed → show the record's own synced metadata with
  // presence unknown (rendered as plain links; only an explicit present:false
  // gets the "not on this machine" pill), never a false "No attachments".
  const shownAttachments = attachments === 'failed' ? (song?.attachments || []) : (attachments || []);

  // Keyed on the content STRING (not the song object) so unrelated record
  // updates (stage flips, attachment meta) don't re-run the transpose pass.
  const contentText = song?.content?.text || '';
  // A drum chart renders on the kit grid and plays back through the drum
  // transport; transpose and chord voicings are meaningless for it.
  const isDrum = (song?.content?.format || 'tab') === DRUM_FORMAT;
  const renderedText = useMemo(
    () => (transpose && !isDrum ? transposeText(contentText, transpose) : contentText),
    [contentText, transpose, isDrum],
  );

  // Edit-form selects carry whatever the DRAFT holds, even when this client's
  // enum doesn't list it (a song synced from a newer peer) — so a save preserves
  // the stored value instead of coercing it to the first option.
  const draftIsDrum = draft?.format === DRUM_FORMAT;
  const instrumentOptions = useMemo(() => withStoredOption(INSTRUMENTS, draft?.instrument), [draft?.instrument]);
  const formatOptions = useMemo(() => withStoredOption(SONG_FORMATS, draft?.format), [draft?.format]);

  // Picking the Drums instrument defaults the format to the kit grid (only while
  // the sheet is still empty — never re-formatting text the user already wrote).
  const onInstrumentChange = useCallback((instrument) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, instrument };
      if (instrument === DRUM_INSTRUMENT && !prev.text.trim()) next.format = DRUM_FORMAT;
      return next;
    });
  }, []);

  // --- Drum play-along (kit synth, practice tempo, loop, playhead).
  // The hook is called unconditionally (hooks rule); it parses to zero bars for
  // a non-drum song, so it stands up no player and touches no audio.
  const drum = useDrumPlayer(isDrum ? contentText : '', { songId: id });

  // The wake lock holds while either play-mode hands-free surface is running.
  // Edit-preview audio owns its lifecycle inside DrumPreview.
  useWakeLock(playing || drum.playing);

  // Leaving play mode (Edit) or unmounting must not leave the kit sounding — the
  // hook tears the player down on unmount, but a mode flip keeps it mounted.
  useEffect(() => { if (editing) drum.stop(); }, [editing, drum.stop]);

  const scrollToTop = useCallback(() => {
    stop();
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [stop]);

  // Play-mode shortcuts. A drum chart rebinds them onto the kit transport (space
  // play/stop, +/- BPM, [ ] loop ends, m mutes the click) since transpose/
  // scroll-speed don't apply.
  const drumShortcuts = {
    ' ': drum.toggle,
    m: () => drum.setClickEnabled(!drum.clickEnabled),
    '+': () => drum.setBpm(drum.bpm + 1),
    '=': () => drum.setBpm(drum.bpm + 1),
    '-': () => drum.setBpm(drum.bpm - 1),
    '[': () => { drum.setLoopEnabled(true); drum.setLoopRange(drum.currentBar, drum.loopTo); },
    ']': () => { drum.setLoopEnabled(true); drum.setLoopRange(drum.loopFrom, drum.currentBar); },
    '0': scrollToTop,
  };
  const sheetShortcuts = {
    ' ': toggle,
    '+': () => setPxPerSec((v) => Math.min(SPEED_MAX, v + 5)),
    '=': () => setPxPerSec((v) => Math.min(SPEED_MAX, v + 5)),
    '-': () => setPxPerSec((v) => Math.max(SPEED_MIN, v - 5)),
    '[': () => setTranspose(transpose - 1),
    ']': () => setTranspose(transpose + 1),
    '0': scrollToTop,
  };
  useKeyboardShortcuts(!editing && !!song, isDrum ? drumShortcuts : sheetShortcuts);

  // --- Mutations
  const onStageChange = useCallback((stage) => {
    // PATCH just the stage (defaults-free partial). Helper toast owns the error
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

  // --- Unsaved-edit guard (#3902)
  // The editor holds everything in `draft` until an explicit Save, so leaving
  // edit mode (View toggle, "All songs", a tab close) would drop sheet text and
  // practice notes silently. `pendingExit` holds the deferred navigation while
  // the inline discard confirm is up.
  const isDirty = useMemo(
    () => !!song && !!draft && !draftsEqual(draft, toDraft(song)),
    [song, draft],
  );
  const [pendingExit, setPendingExit] = useState(null);
  // A save (or a discard) settles the draft — any armed confirm is now moot.
  useEffect(() => { if (!isDirty) setPendingExit(null); }, [isDirty]);
  // Store the exit as a value, not as a state updater (setState(fn) would CALL it).
  const requestExit = useCallback((run) => {
    if (isDirty) setPendingExit(() => run);
    else run();
  }, [isDirty]);
  // Route-link clicks can't be deferred by returning false — swallow the default
  // navigation and re-run it from the confirm instead.
  const onLeaveLink = useCallback((e) => {
    if (!isDirty) return;
    e.preventDefault();
    setPendingExit(() => () => navigate('/songbook'));
  }, [isDirty, navigate]);
  const discardAndExit = useCallback(() => {
    setDraft(song ? toDraft(song) : null);
    setPendingExit(null);
    pendingExit?.();
  }, [pendingExit, song]);
  // Tab close / reload — the browser owns this prompt; preventDefault arms it.
  useEffect(() => {
    if (!isDirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  const onDeleteSong = useCallback(() => confirmDelete(() =>
    deleteSong(id, { silent: true })
      .then(() => navigate('/songbook'))
      .catch((err) => toast.error(err?.message || 'Failed to delete song')),
  ), [confirmDelete, id, navigate]);

  // --- Attachments
  const [uploadFiles, uploading] = useAsyncAction(async (files) => {
    for (const file of Array.from(files)) {
      if (file.size > JSON_UPLOAD_MAX_FILE_SIZE) {
        toast.error(`"${file.name}" exceeds the ${formatBytes(JSON_UPLOAD_MAX_FILE_SIZE)} limit`);
        continue;
      }
      // Per-file failure isolation (#3901): a rejected read/upload must not
      // abort the rest of a multi-file selection. Catch here (rather than
      // letting it bubble to useAsyncAction's single generic toast) so the
      // toast names the file that failed and the loop keeps going.
      const res = await readFileAsBase64(file)
        .then((data) => uploadSongAttachment(id, { filename: file.name, data }, { silent: true }))
        .catch((err) => {
          toast.error(`Failed to upload "${file.name}": ${err?.message || 'Upload failed'}`);
          return null;
        });
      if (res?.attachment) {
        attachmentsMutatedRef.current = true;
        // `prev` may be the 'failed' sentinel — spreading a string would yield
        // six single-character entries, so fall back to the synced list (#3900).
        setAttachments((prev) => [
          ...(Array.isArray(prev) ? prev : (song?.attachments || [])),
          { ...res.attachment, present: true },
        ]);
      }
    }
  }, { errorMessage: 'Upload failed' });

  const onDeleteAttachment = useCallback((filename) => confirmDelete(() =>
    deleteSongAttachment(id, filename, { silent: true })
      .then((res) => {
        attachmentsMutatedRef.current = true;
        // Server returns the updated meta list; carry over local present flags.
        // `prev` is the 'failed' sentinel when the presence lookup errored, and
        // `.find()` on that string throws (#3900). Presence carries over only
        // where it is an explicitly-known boolean — an entry we never resolved
        // (failed lookup, or a synced entry appended after one) stays unknown
        // so it renders as a link, not a false "not on this machine".
        setAttachments((prev) => {
          const known = Array.isArray(prev) ? prev : [];
          return (res?.attachments || []).map((meta) => {
            const prior = known.find((a) => a.filename === meta.filename)?.present;
            return typeof prior === 'boolean' ? { ...meta, present: prior } : { ...meta };
          });
        });
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
            <Link to="/songbook" onClick={onLeaveLink} className={btnClass}>
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
                  onClick={() => requestExit(() => setMode('play'))}
                  className={btnClass}
                >
                  <Eye size={15} />
                  View
                </button>
              </>
            ) : (
              <button
                type="button"
                // Explicitly stop autoscroll before the play-mode scroll node
                // unmounts (the detached-element bottom check would also stop
                // it, but deterministic beats incidental).
                onClick={() => { stop(); setMode('edit'); }}
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

      {/* Unsaved-edit guard — a full-width band under the header, so the
          deferred exit is confirmed where the user just clicked. */}
      {pendingExit && (
        <InlineConfirmRow
          className="shrink-0"
          variant="separator"
          tone="warning"
          question="Discard your unsaved changes to this song?"
          confirmText="Discard"
          cancelText="Keep editing"
          onConfirm={discardAndExit}
          onCancel={() => setPendingExit(null)}
          autoFocus
          aria-label={`Discard unsaved changes to ${song.title}`}
        />
      )}

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
              {/* withStoredOption keeps a value this client doesn't know (a song
                  synced from a newer peer) in the list, so saving round-trips it
                  instead of silently coercing to the first option. */}
              <select id="song-edit-instrument" value={draft.instrument} onChange={(e) => onInstrumentChange(e.target.value)} className={inputClass}>
                {instrumentOptions.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
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
                    {formatOptions.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                </div>
              </div>
              <AutoSizeTextarea
                id="song-edit-text"
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                placeholder={draftIsDrum ? DRUM_PLACEHOLDER : '[Verse 1]\nC        G\nExample lyrics here…'}
                spellCheck={false}
                className={`${inputClass} font-mono min-h-[280px] whitespace-pre`}
              />
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-1">Preview</div>
              <div className={`bg-port-card border border-port-border rounded-lg overflow-hidden ${draftIsDrum ? '' : 'p-3 overflow-x-auto'}`}>
                {draftIsDrum ? (
                  <DrumPreview
                    text={draft.text}
                    songId={id}
                    fontSizeRem={fontSize}
                    sheetClassName="p-3"
                    settingsMirror={drum}
                  />
                ) : (
                  <TabSheetView
                    text={draft.text}
                    format={draft.format}
                    fontSizeRem={fontSize}
                    instrumentView={toVoicingInstrument(draft.instrument)}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ============================== PLAY MODE ============================== */
        <>
          {/* Drum play-along transport — its own bar above the shared controls,
              so the kit's tempo/loop/click sit together rather than interleaved
              with the sheet controls. */}
          {isDrum && (
            <DrumTransportBar
              playing={drum.playing}
              onToggle={drum.toggle}
              hasMusic={drum.hasMusic}
              bpm={drum.bpm}
              onBpmChange={drum.setBpm}
              onPercent={drum.setBpmPercent}
              writtenTempo={drum.writtenTempo}
              countInBars={drum.countInBars}
              onCountInChange={drum.setCountInBars}
              loopEnabled={drum.loopEnabled}
              onLoopToggle={drum.setLoopEnabled}
              loopFrom={drum.loopFrom}
              loopTo={drum.loopTo}
              onLoopRangeChange={drum.setLoopRange}
              barCount={drum.barCount}
              clickEnabled={drum.clickEnabled}
              onClickToggle={drum.setClickEnabled}
              clickVolume={drum.clickVolume}
              onClickVolumeChange={drum.setClickVolume}
              kitId={drum.kitId}
              onKitChange={drum.setKitId}
              beatsPerBar={drum.beatsPerBar}
              pulse={drum.pulse}
              currentBar={drum.currentBar}
            />
          )}

          <div className="shrink-0 border-b border-port-border bg-port-card/60 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* Autoscroll — a drum chart scrolls HORIZONTALLY under its own
                playhead (DrumSheetView), so a second vertical-scroll play button
                would be a rival transport with a rival meaning of "play". */}
            {!isDrum && (
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
            )}

            {/* Transpose — meaningless on a kit grid, so hidden for drum charts */}
            {!isDrum && (
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
            )}

            {/* Font size — on a drum chart the same control zooms the kit grid
                (DrumSheetView scales the whole strip off fontSizeRem), so it's
                labelled for what it actually does there. */}
            <div className="flex items-center gap-1" role="group" aria-label={isDrum ? 'Grid size' : 'Font size'}>
              <button type="button" onClick={() => setFontSize(fontSize - FONT_STEP)} className={`${ctrlBtnClass} text-xs font-bold`} aria-label={isDrum ? 'Zoom out' : 'Smaller text'}>
                A−
              </button>
              <button type="button" onClick={() => setFontSize(fontSize + FONT_STEP)} className={`${ctrlBtnClass} text-sm font-bold`} aria-label={isDrum ? 'Zoom in' : 'Larger text'}>
                A+
              </button>
            </div>

            {/* Instrument view (chord diagrams) — render-only, URL-backed. A drum
                chart has no chords to voice, so the picker hides. */}
            {!isDrum && (
              <TabPills
                variant="pills"
                size="sm"
                tabs={VIEW_TABS}
                activeTab={instrumentView}
                onChange={setInstrumentView}
                ariaLabel="Instrument view"
                mobileDropdown
                mobileSelectId="song-instrument-view"
              />
            )}

            {/* Stage */}
            <div>
              <label htmlFor="song-stage" className="sr-only">Learning stage</label>
              <select
                id="song-stage"
                value={song.stage || 'new'}
                onChange={(e) => onStageChange(e.target.value)}
                className={`text-xs rounded-full border px-2 py-2 min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent ${stageClass}`}
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

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 sm:px-4 sm:py-4">
            {song.content?.text && isDrum ? (
              // Full width, not max-w-4xl: the kit strip IS the horizontal
              // scroller, so capping it just shortens the window you read
              // through on a wide screen.
              <DrumSheetView
                // Keyed on the song, not just its text: the sheet resets its
                // horizontal scroll when the CHART changes, and two songs can
                // hold identical charts. Today the load's `setSong(null)`
                // unmounts the sheet between songs anyway, but that's an
                // incidental guarantee — the key makes it the sheet's own.
                key={id}
                text={contentText}
                fontSizeRem={fontSize}
                getPlayhead={drum.getPlayhead}
                playing={drum.playing}
              />
            ) : song.content?.text ? (
              <TabSheetView
                text={renderedText}
                format={song?.content?.format || 'tab'}
                fontSizeRem={fontSize}
                className="max-w-4xl"
                instrumentView={instrumentView}
                showChordStrip
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
                  <FilePickerButton
                    multiple
                    onChange={(e) => uploadFiles(e.target.files)}
                    disabled={uploading}
                    ariaLabel="Upload attachment"
                    className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50"
                  >
                    <Upload size={13} />
                    {uploading ? 'Uploading…' : 'Upload'}
                  </FilePickerButton>
                </div>
              </div>
              {attachments === null ? (
                <p className="text-xs text-gray-500">Loading attachments…</p>
              ) : shownAttachments.length === 0 ? (
                <p className="text-xs text-gray-500">No attachments — upload sheet-music PDFs, images, or MIDI files.</p>
              ) : (
                <ul className="space-y-1">
                  {shownAttachments.map((att) => (
                    <li key={att.filename} className="flex items-center gap-3 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm">
                      {att.present !== false ? (
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
