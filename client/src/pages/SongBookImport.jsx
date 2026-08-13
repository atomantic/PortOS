/**
 * SongBook import — /songbook/import (plain padded page, NOT full-width).
 *
 * Two URL-param-driven tabs (?tab=paste|url, TabPills):
 * - PASTE: font-mono textarea (+ clipboard Paste / Sample / Clear buttons).
 *   Content runs through normalizePastedTab; detectFormat + parseTabSheet
 *   drive a live preview (the same TabSheetView the viewer renders) and
 *   prefill title/artist/key/capo from ChordPro meta.
 * - URL: input validated with isUrl; Fetch POSTs to the server-side extractor
 *   which returns a draft ({ title, artist, content, sourceUrl }) — nothing is
 *   stored until the user reviews and Saves.
 *
 * Below either tab: a draft form (title/artist/instrument/stage/tags) → Save →
 * createSong → navigate to the new song's viewer.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { toVoicingInstrument } from '../lib/chordShapes.js';
import { useNavigate, Link } from 'react-router';
import { ListMusic, ArrowLeft, ClipboardPaste, Eraser, Wand2, Globe, FileText, Save, AlertTriangle, RotateCw } from 'lucide-react';
import toast from '../components/ui/Toast';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import TabSheetView from '../components/songbook/TabSheetView';
import DrumPreview from '../components/songbook/DrumPreview';
import {
  SONG_STAGES, INSTRUMENTS, DRUM_FORMAT, DRUM_INSTRUMENT,
  inputClass, labelClass, btnClass,
} from '../components/songbook/constants';
import { useAsyncAction } from '../hooks/useAsyncAction';
import useDrawerTab from '../hooks/useDrawerTab';
import { createSong, importSongFromUrl } from '../services/api';
import { normalizePastedTab, detectFormat, parseTabSheet } from '../lib/tabNotation.js';
import { isDrumNotation } from '../lib/drumNotation.js';
import { readClipboard } from '../lib/clipboard.js';
import { isUrl, normalizeUrl } from '../utils/urlNormalize';

// Invented placeholder sheet — demonstrates sections, chord lines, and a tab
// staff without any real song data (privacy convention).
const SAMPLE_TAB = `[Intro]
e|--0--2--3--2--0------|
B|--------------3--1--0|

[Verse 1]
C        G        Am       F
Placeholder words in every line
C        G          F
Nothing here is a real song

[Chorus]
F        G        C
La la la, la la la`;

// Server import error codes → user-actionable messages (we own the error UI
// here, so the API call passes { silent: true }).
const IMPORT_ERROR_MESSAGES = {
  UNSAFE_URL: 'That URL can\'t be fetched — only public http(s) addresses are allowed.',
  SONG_IMPORT_FETCH_FAILED: 'Couldn\'t fetch that page — check the URL or try copy/pasting the tab instead.',
  SONG_IMPORT_EMPTY: 'No tab or chord content found on that page — try copy/pasting the tab instead.',
};

const importErrorMessage = (err) => IMPORT_ERROR_MESSAGES[err?.code] || err?.message || 'Import failed';

const TABS = [
  { id: 'paste', label: 'Paste', icon: FileText },
  { id: 'url', label: 'From URL', icon: Globe },
];

export default function SongBookImport() {
  const navigate = useNavigate();
  // URL-backed tab state (default omitted from the URL, replace-history writes).
  const [tab, setTab] = useDrawerTab('tab', 'paste', ['paste', 'url']);

  // Paste tab state
  const [pasted, setPasted] = useState('');
  const normalized = useMemo(() => normalizePastedTab(pasted), [pasted]);
  const pasteMeta = useMemo(() => (normalized ? parseTabSheet(normalized).meta : {}), [normalized]);

  // URL tab state
  const [url, setUrl] = useState('');
  const [fetched, setFetched] = useState(null); // server draft: { title, artist, content, sourceUrl }
  // null = no failure. A failed fetch keeps its message on screen (the toast is
  // transient) so the URL still sitting in the input has visible context.
  const [fetchError, setFetchError] = useState(null);

  // Shared draft form
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [instrument, setInstrument] = useState('guitar');
  const [stage, setStage] = useState('new');
  const [tags, setTags] = useState('');

  // Last values WE auto-filled — so a second import can replace a stale
  // auto-fill (still equal to what we set) without clobbering user edits.
  const autoFilledRef = useRef({ title: '', artist: '' });

  const applyMetaDefaults = useCallback((meta) => {
    // Prefill untouched fields; a field still holding the PREVIOUS auto-fill
    // counts as untouched, so importing song B after song A refreshes it —
    // including CLEARING it when B carries no metadata (otherwise A's title
    // silently saves onto B's content). Genuine user edits are never touched.
    const prev = { ...autoFilledRef.current };
    const next = { title: meta?.title || '', artist: meta?.artist || '' };
    autoFilledRef.current = next;
    setTitle((cur) => (!cur || cur === prev.title ? next.title : cur));
    setArtist((cur) => (!cur || cur === prev.artist ? next.artist : cur));
  }, []);

  const onPasteButton = useCallback(async () => {
    const text = await readClipboard();
    if (text == null) { toast.error('Clipboard unavailable — paste into the box instead'); return; }
    // Store the RAW clipboard text — the `normalized` memo runs the single
    // normalize pass. Pre-normalizing here would double entity-decode
    // (&amp;lt; → &lt; → <) and strip entity-encoded markup as if it were tags.
    setPasted(text);
    applyMetaDefaults(parseTabSheet(normalizePastedTab(text)).meta);
  }, [applyMetaDefaults]);

  // The input stays editable while a fetch is in flight, so the request that
  // resolves may no longer be the one the form is showing. Refs (not the stale
  // closure values) say what's on screen when the promise settles.
  const urlRef = useRef(url);
  urlRef.current = url;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // Error mapping lives in the .catch alone — it swallows every rejection, so
  // a useAsyncAction errorMessage layer could never fire (single toast layer).
  const [fetchUrl, fetching] = useAsyncAction(async () => {
    const submittedUrl = url;
    const normalizedUrl = normalizeUrl(submittedUrl);
    if (!normalizedUrl || !isUrl(normalizedUrl)) { toast.error('Enter a valid URL'); return null; }
    // A result for a URL the user has since edited away from — or for a tab
    // they've left — must not write itself over what's on screen now.
    const isCurrent = () => urlRef.current === submittedUrl && tabRef.current === 'url';
    const data = await importSongFromUrl(normalizedUrl, { silent: true }).catch((err) => {
      // The toast is gated too — a failure for a URL the user has already typed
      // past is not news about the form they're looking at.
      if (!isCurrent()) return null;
      const message = importErrorMessage(err);
      toast.error(message);
      // Drop any earlier draft: leaving the previous song previewed under a
      // failed URL is exactly the stale-form confusion this guards against.
      setFetched(null);
      applyMetaDefaults({});
      setFetchError(message);
      return null;
    });
    const draft = data?.draft;
    if (!draft || !isCurrent()) return null;
    setFetchError(null);
    setFetched(draft);
    applyMetaDefaults(draft);
    return draft;
  });

  // The active tab's content → what Save will store.
  const contentText = tab === 'url' ? (fetched?.content?.text || '') : normalized;
  const fetchedFormat = fetched?.content?.format;

  // Switching tabs switches WHICH draft Save submits — re-apply that draft's
  // metadata so auto-filled title/artist follow the active source instead of
  // saving tab A's metadata onto tab B's content. Refs keep the effect keyed
  // on the tab alone (meta changes apply at their own paste/fetch sites).
  const activeMetaRef = useRef({});
  activeMetaRef.current = tab === 'url'
    ? { title: fetched?.title, artist: fetched?.artist }
    : { title: pasteMeta?.title, artist: pasteMeta?.artist };
  useEffect(() => {
    applyMetaDefaults(activeMetaRef.current);
  }, [tab, applyMetaDefaults]);
  // Memoized on its real inputs so the classifier passes don't re-run on every
  // unrelated keystroke (title/artist/tags). Precedence, highest first:
  //
  // 1. A recognized drum grid (`isDrumNotation`) — this runs BEFORE `detectFormat`
  //    because a grid row would otherwise classify as plain text (#3115). It also
  //    beats the server's `fetchedFormat`: the URL extractor returns generic text
  //    and has no drum awareness, so its `tab`/`plain` guess must not override an
  //    unmistakable chart.
  // 2. The chosen Drums instrument — the user saying "this is a kit chart"
  //    outranks any guess, and covers a chart the sniff can't read yet
  //    (mid-typing) as well as one the URL extractor already labelled `tab`.
  // 3. The server's format for a URL import, then `detectFormat` for a paste.
  const contentFormat = useMemo(() => {
    if (isDrumNotation(contentText)) return DRUM_FORMAT;
    if (instrument === DRUM_INSTRUMENT) return DRUM_FORMAT;
    if (tab === 'url' && fetchedFormat) return fetchedFormat;
    return detectFormat(contentText);
  }, [tab, fetchedFormat, contentText, instrument]);
  const previewIsDrum = contentFormat === DRUM_FORMAT;

  // Why Save is disabled — otherwise a failed URL import surfaces only as the
  // unrelated "Nothing to save" toast once the user clicks.
  const saveHint = contentText.trim()
    ? null
    : (tab === 'url' && fetchError
      ? 'That URL import failed — retry it above, or switch to Paste and paste the tab.'
      : 'Paste or fetch a tab first — there\'s nothing to save yet.');

  const [save, saving] = useAsyncAction(async () => {
    const name = title.trim();
    if (!name) { toast.error('Give the song a title'); return null; }
    if (!contentText.trim()) { toast.error('Nothing to save — paste or fetch a tab first'); return null; }
    const body = {
      title: name,
      artist: artist.trim(),
      instrument,
      stage,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      content: { format: contentFormat, text: contentText },
    };
    if (tab === 'url' && fetched?.sourceUrl) body.sourceUrl = fetched.sourceUrl;
    if (tab === 'paste') {
      // Clamp ChordPro meta to songInputSchema's bounds — a pasted {capo: 13}
      // or an over-long {key:} must not 400 the POST with no form field to fix.
      if (pasteMeta.key) body.key = String(pasteMeta.key).slice(0, 20);
      if (Number.isInteger(pasteMeta.capo) && pasteMeta.capo >= 0 && pasteMeta.capo <= 12) {
        body.capo = pasteMeta.capo;
      }
    }
    const song = await createSong(body, { silent: true });
    if (song?.id) navigate(`/songbook/${song.id}`);
    return song;
  }, { errorMessage: 'Failed to save song' });

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        icon={ListMusic}
        title="Import Song"
        subtitle="Paste a tab or fetch one from a URL, review, then save"
        actions={(
          <Link to="/songbook" className={btnClass}>
            <ArrowLeft size={15} />
            SongBook
          </Link>
        )}
      />

      <TabPills tabs={TABS} activeTab={tab} onChange={setTab} size="sm" ariaLabel="Import source" />

      <div className="flex-1 overflow-auto p-3 sm:p-4">

      {tab === 'paste' ? (
        <div className="mb-4">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <button type="button" onClick={onPasteButton} className={btnClass}>
              <ClipboardPaste size={14} />
              Paste
            </button>
            <button type="button" onClick={() => { setPasted(SAMPLE_TAB); }} className={btnClass}>
              <Wand2 size={14} />
              Sample
            </button>
            <button type="button" onClick={() => setPasted('')} disabled={!pasted} className={btnClass}>
              <Eraser size={14} />
              Clear
            </button>
            {normalized && (
              <span className="text-xs text-gray-500 ml-auto">
                Detected format: <span className="text-port-accent">{contentFormat}</span>
              </span>
            )}
          </div>
          <label htmlFor="import-paste" className="sr-only">Pasted tab content</label>
          <textarea
            id="import-paste"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            onBlur={() => applyMetaDefaults(pasteMeta)}
            placeholder="Paste a guitar tab, chord sheet, or ChordPro file here…"
            spellCheck={false}
            rows={12}
            className={`${inputClass} font-mono whitespace-pre resize-y`}
          />
        </div>
      ) : (
        <div className="mb-4">
          <form
            onSubmit={(e) => { e.preventDefault(); fetchUrl(); }}
            className="flex flex-col sm:flex-row gap-2 sm:items-end"
          >
            <div className="flex-1">
              <label htmlFor="import-url" className={labelClass}>Tab / chord-sheet URL</label>
              <input
                id="import-url"
                type="text"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setFetchError(null); }}
                placeholder="https://example.com/tabs/example-song"
                className={inputClass}
              />
            </div>
            <button
              type="submit"
              disabled={fetching || !isUrl(normalizeUrl(url) || '')}
              className="flex items-center justify-center gap-2 px-4 py-2 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
            >
              <Globe size={15} />
              {fetching ? 'Fetching…' : 'Fetch'}
            </button>
          </form>
          {fetchError && (
            <div
              role="alert"
              className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300"
            >
              <AlertTriangle size={14} className="shrink-0" />
              <span className="flex-1">
                Import failed — {fetchError} Nothing was fetched, so there&apos;s nothing to save yet.
              </span>
              <button
                type="button"
                onClick={() => fetchUrl()}
                disabled={fetching || !isUrl(normalizeUrl(url) || '')}
                className={`${btnClass} shrink-0`}
              >
                <RotateCw size={13} />
                Retry
              </button>
            </div>
          )}
          {fetched && (
            <p className="text-xs text-gray-500 mt-2">
              Fetched <span className="text-gray-300">{fetched.title || 'untitled'}</span>
              {fetched.artist ? <> by <span className="text-gray-300">{fetched.artist}</span></> : null}
              {' — '}format <span className="text-port-accent">{contentFormat}</span>. Review below, then save.
            </p>
          )}
        </div>
      )}

      {/* Live preview (shared renderer with the viewer) */}
      {contentText && (
        <div className="mb-4">
          <div className="text-xs text-gray-400 mb-1">Preview</div>
          <div className={`bg-port-card border border-port-border rounded-lg max-h-[50vh] overflow-y-auto overflow-x-auto ${previewIsDrum ? '' : 'p-3'}`}>
            {previewIsDrum ? (
              <DrumPreview
                text={contentText}
                sheetClassName="p-3"
              />
            ) : (
              <TabSheetView
                text={contentText}
                format={contentFormat}
                instrumentView={toVoicingInstrument(instrument)}
              />
            )}
          </div>
        </div>
      )}

      {/* Draft form */}
      <form
        onSubmit={(e) => { e.preventDefault(); save(); }}
        className="bg-port-card border border-port-border rounded-lg p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"
      >
        <div className="lg:col-span-1">
          <label htmlFor="import-title" className={labelClass}>Title</label>
          <input id="import-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Example Song" className={inputClass} />
        </div>
        <div>
          <label htmlFor="import-artist" className={labelClass}>Artist</label>
          <input id="import-artist" type="text" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="e.g. The Placeholders" className={inputClass} />
        </div>
        <div>
          <label htmlFor="import-instrument" className={labelClass}>Instrument</label>
          <select id="import-instrument" value={instrument} onChange={(e) => setInstrument(e.target.value)} className={inputClass}>
            {INSTRUMENTS.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="import-stage" className={labelClass}>Stage</label>
          <select id="import-stage" value={stage} onChange={(e) => setStage(e.target.value)} className={inputClass}>
            {SONG_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="import-tags" className={labelClass}>Tags (comma-separated)</label>
          <input id="import-tags" type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. campfire" className={inputClass} />
        </div>
        <div className="sm:col-span-2 lg:col-span-5 flex flex-col sm:flex-row sm:items-center gap-2">
          <button
            type="submit"
            disabled={saving || !contentText.trim()}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
          >
            <Save size={15} />
            {saving ? 'Saving…' : 'Save song'}
          </button>
          {saveHint && <span className="text-xs text-gray-400">{saveHint}</span>}
        </div>
      </form>
      </div>
    </div>
  );
}
