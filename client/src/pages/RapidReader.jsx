import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookOpen, ClipboardPaste, Eraser, ExternalLink, Play, Save, Trash2, Zap } from 'lucide-react';
import RapidReader from '../components/RapidReader';
import PageHeader from '../components/PageHeader';
import { readClipboard } from '../lib/clipboard';
import {
  clearRapidReaderProgress,
  rapidReaderDocumentId,
  rapidReaderWords,
  rapidReaderWordIndexAtCursor,
  readRapidReaderProgress,
  writeRapidReaderProgress,
} from '../lib/rapidReaderPosition';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useNavigate, useParams } from 'react-router';
import {
  ACCELERANDO_LICENSE_URL,
  ACCELERANDO_SOURCE_PAGE_URL,
  createRapidReaderLibraryEntry,
  deleteRapidReaderLibraryEntry,
  fetchRapidReaderLibraryEntry,
  getAccelerandoBook,
  getRapidReaderLibraryEntry,
  listRapidReaderLibrary,
} from '../services/api';

const SAMPLE = `Speed reading is a collection of techniques used to scan text quickly while still understanding what you've read. Most people read in chunks of three or four words at a time, which slows them down. Rapid serial visual presentation flashes one word at a time at a fixed location, removing the need to move your eyes. With practice, comprehension stays intact at three to five hundred words per minute, and many readers can push past six hundred for familiar material.`;

const focalPalette = [
  { value: '#ef4444', label: 'Red' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#22c55e', label: 'Green' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#a855f7', label: 'Purple' }
];

export default function RapidReaderPage() {
  const navigate = useNavigate();
  const { id: shelfId } = useParams();
  const [text, setText] = useState('');
  const [active, setActive] = useState(null);
  const [wpm, setWpm] = useState(350);
  const [chunkSize, setChunkSize] = useState(1);
  const [focalColor, setFocalColor] = useState('#ef4444');
  const [bookmark, setBookmark] = useState(null);
  const [bookStatus, setBookStatus] = useState('idle');
  const [bookError, setBookError] = useState('');
  const [shelf, setShelf] = useState([]);
  const [shelfError, setShelfError] = useState('');
  const [shelfLoading, setShelfLoading] = useState(true);
  const [saveTitle, setSaveTitle] = useState('');
  const [url, setUrl] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [bookText, setBookText] = useState('');
  const [bookSections, setBookSections] = useState([]);
  const textareaRef = useRef(null);
  const latestProgressRef = useRef(null);
  const lastAutoSavedWordRef = useRef(-1);

  const documentText = useMemo(() => text.trim(), [text]);
  const wordCount = useMemo(() => rapidReaderWords(documentText).length, [documentText]);
  const documentIdentity = useMemo(() => ({
    documentId: rapidReaderDocumentId(documentText),
    wordCount,
  }), [documentText, wordCount]);

  useEffect(() => {
    setBookmark(readRapidReaderProgress(documentText, documentIdentity));
  }, [documentText, documentIdentity]);

  const loadShelf = useCallback(async () => {
    setShelfLoading(true); setShelfError('');
    const entries = await listRapidReaderLibrary({ silent: true }).catch((error) => { setShelfError(error?.message || 'Could not load shelf'); return null; });
    if (entries) setShelf(entries);
    setShelfLoading(false);
  }, []);
  useEffect(() => { loadShelf(); }, [loadShelf]);

  const [loadBook, loadingBook] = useAsyncAction(async () => {
    setBookStatus('loading');
    setBookError('');
    const book = await getAccelerandoBook({ silent: true }).catch((error) => {
      setBookStatus('error');
      setBookError(error?.message || 'Could not load Accelerando');
      return null;
    });
    if (!book) return null;
    if (typeof book?.text !== 'string' || !book.text.trim()) {
      setBookStatus('error');
      setBookError('The Accelerando response was invalid — please retry');
      return null;
    }
    setText(book.text);
    if (book.id === 'accelerando' && book.shelfStored !== false) setShelf((previous) => previous.some((entry) => entry.id === book.id) ? previous : [{ ...book, text: undefined }, ...previous]);
    setBookText(book.text);
    setBookSections(Array.isArray(book.sections) ? book.sections : []);
    setBookStatus(book.cached ? 'cached' : book.cacheStored === false ? 'downloaded-uncached' : 'downloaded');
    return book;
  });

  // The URL owns which shelf entry is open, so the row click only navigates —
  // the effect below is the single place that loads the record's text.
  const openShelf = (id) => navigate(`/rapid-reader/${id}`);
  const loadShelfEntry = useCallback(async (id) => {
    const entry = await getRapidReaderLibraryEntry(id, { silent: true }).catch((error) => { setShelfError(error?.message || 'Could not open shelf entry'); return null; });
    if (entry?.text) { setText(entry.text); setActive({ text: entry.text, initialWordIndex: 0, documentId: rapidReaderDocumentId(entry.text), wordCount: entry.wordCount }); }
  }, []);
  useEffect(() => { if (shelfId) loadShelfEntry(shelfId); }, [shelfId, loadShelfEntry]);
  const addToShelf = (entry) => setShelf((previous) => [Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'text')), ...previous]);
  const [saveToShelf, savingShelf] = useAsyncAction(async () => {
    const entry = await createRapidReaderLibraryEntry({ title: saveTitle, text: documentText }, { silent: true }).catch((error) => { setShelfError(error?.message || 'Could not save to shelf'); return null; });
    if (entry) { addToShelf(entry); setSaveTitle(''); }
  });
  const [fetchToShelf, fetchingShelf] = useAsyncAction(async () => {
    const entry = await fetchRapidReaderLibraryEntry({ url }, { silent: true }).catch((error) => { setShelfError(error?.message || 'Could not fetch URL'); return null; });
    if (entry) { addToShelf(entry); setUrl(''); }
  });
  const deleteShelf = async (id) => {
    const deleted = await deleteRapidReaderLibraryEntry(id, { silent: true }).then(() => true, (error) => { setShelfError(error?.message || 'Could not delete shelf entry'); return false; });
    if (deleted) { setShelf((previous) => previous.filter((entry) => entry.id !== id)); setPendingDelete(null); }
  };

  const startAt = (wordIndex, saved = null) => {
    if (!documentText) return;
    if (saved) {
      setWpm(saved.wpm);
      setChunkSize(saved.chunkSize);
    }
    latestProgressRef.current = null;
    lastAutoSavedWordRef.current = -1;
    setActive({
      text: documentText,
      initialWordIndex: wordIndex,
      sections: documentText === bookText ? bookSections : [],
      ...documentIdentity,
    });
  };

  const persistProgress = useCallback((document, progress, updateBookmark = true) => {
    if (!document?.text || !progress || progress.wordIndex <= 0) return;
    if (progress.wordIndex >= progress.wordCount - 1) {
      clearRapidReaderProgress(document.text, document);
      if (updateBookmark) setBookmark(null);
      return;
    }
    const saved = writeRapidReaderProgress(document.text, progress, document);
    if (saved && updateBookmark) setBookmark(saved);
  }, []);

  const handlePositionChange = useCallback((progress) => {
    latestProgressRef.current = progress;
    if (!active || progress.wordIndex <= 0) return;
    if (lastAutoSavedWordRef.current >= 0 && progress.wordIndex - lastAutoSavedWordRef.current < 10) return;
    lastAutoSavedWordRef.current = progress.wordIndex;
    persistProgress(active, progress);
  }, [active, persistProgress]);

  const saveBookmark = useCallback((wordIndex) => {
    if (!active) return;
    persistProgress(active, { ...latestProgressRef.current, wordIndex });
  }, [active, persistProgress]);

  const reset = () => {
    if (active) persistProgress(active, latestProgressRef.current);
    setActive(null);
  };

  const complete = () => {
    if (!active) return;
    clearRapidReaderProgress(active.text, active);
    setBookmark(null);
  };

  useEffect(() => {
    if (!active) return undefined;
    return () => persistProgress(active, latestProgressRef.current, false);
  }, [active, persistProgress]);

  const pasteFromClipboard = async () => {
    const t = await readClipboard();
    if (t) setText(t);
  };

  const estSec = Math.round((wordCount * 60) / Math.max(60, wpm));

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        icon={Zap}
        title="Rapid Reader"
        subtitle="Paste text and read it word-by-word with a highlighted focal letter (Spritz-style RSVP)."
      />

      <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-6">
      {active ? (
        <div className="space-y-4">
          <RapidReader
            text={active.text}
            wpm={wpm}
            chunkSize={chunkSize}
            focalColor={focalColor}
            initialWordIndex={active.initialWordIndex}
            sections={active.sections}
            autoPlay
            onClose={reset}
            onComplete={complete}
            onPositionChange={handlePositionChange}
            onBookmark={saveBookmark}
            onWpmChange={setWpm}
            onChunkSizeChange={setChunkSize}
          />
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span className="hidden sm:inline">Space = play/pause · ← → step · B bookmark · R restart · +/− WPM · Esc close</span>
            <span>Progress also saves automatically while reading.</span>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div className="flex items-start gap-3">
                <BookOpen size={20} className="mt-0.5 text-port-accent shrink-0" aria-hidden="true" />
                <div>
                  <h2 className="text-sm font-medium text-gray-200">Accelerando</h2>
                  <p className="text-xs text-gray-400">Charles Stross · official HTML edition</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => loadBook()}
                disabled={loadingBook}
                className="inline-flex items-center justify-center min-h-10 px-3 py-2 rounded-md bg-port-accent text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-port-accent/90"
              >
                {loadingBook ? 'Loading…' : 'Load Accelerando'}
              </button>
            </div>
            <p className="text-xs leading-5 text-gray-400">
              Downloads the author-hosted book when requested, then keeps the source in this instance's local cache for repeat and offline reads.
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
              <a
                href={ACCELERANDO_SOURCE_PAGE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-port-accent hover:underline"
              >
                Author's page <ExternalLink size={11} aria-hidden="true" />
              </a>
              <a
                href={ACCELERANDO_LICENSE_URL}
                target="_blank"
                rel="noreferrer"
                className="text-port-accent hover:underline"
              >
                CC BY-NC-ND 2.5
              </a>
            </div>
            {bookStatus === 'downloaded' && (
              <p role="status" className="text-xs text-green-400">Downloaded from the author's site and cached on this instance.</p>
            )}
            {bookStatus === 'downloaded-uncached' && (
              <p role="status" className="text-xs text-yellow-400">Downloaded from the author's site, but this instance could not save its local cache.</p>
            )}
            {bookStatus === 'cached' && (
              <p role="status" className="text-xs text-green-400">Loaded from this instance's local cache.</p>
            )}
            {bookStatus === 'error' && (
              <p role="alert" className="text-xs text-red-400">{bookError}</p>
            )}
          </div>

          <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3" aria-label="Shelf">
            <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-medium text-gray-200">Shelf</h2><p className="text-xs text-gray-400">Saved books stay on this machine and in its backups.</p></div><button type="button" onClick={loadShelf} className="text-xs text-port-accent hover:underline">Retry</button></div>
            {shelfError && <p role="alert" className="text-xs text-red-400">{shelfError}</p>}
            {shelfLoading ? <p className="text-xs text-gray-500">Loading shelf…</p> : shelf.length === 0 ? <p className="text-xs text-gray-500">No saved books yet.</p> : <ul className="divide-y divide-port-border">{shelf.map((entry) => <li key={entry.id} className="py-2 flex flex-wrap items-center justify-between gap-2"><button type="button" onClick={() => openShelf(entry.id)} aria-label={`Open ${entry.title}`} className="text-left min-h-10"><span className="block text-sm text-gray-200">{entry.title}</span><span className="block text-xs text-gray-500">{entry.author || entry.sourceUrl || entry.sourceType} · {entry.wordCount} words</span></button>{pendingDelete === entry.id ? <span className="flex gap-2 text-xs"><button type="button" onClick={() => deleteShelf(entry.id)} className="text-red-400">Delete</button><button type="button" onClick={() => setPendingDelete(null)} className="text-gray-400">Cancel</button></span> : <button type="button" onClick={() => setPendingDelete(entry.id)} aria-label={`Delete ${entry.title}`} className="min-h-10 px-2 text-gray-500 hover:text-red-400"><Trash2 size={15} /></button>}</li>)}</ul>}
          </section>

          <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="rr-text" className="text-sm font-medium text-gray-300">
                Text to read
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={pasteFromClipboard}
                  className="inline-flex items-center gap-1.5 min-h-10 px-2.5 py-1.5 text-xs rounded-md border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50"
                  title="Paste from clipboard"
                >
                  <ClipboardPaste size={12} /> Paste
                </button>
                <button
                  type="button"
                  onClick={() => setText(SAMPLE)}
                  className="inline-flex items-center gap-1.5 min-h-10 px-2.5 py-1.5 text-xs rounded-md border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50"
                >
                  Sample
                </button>
                {text && (
                  <button
                    type="button"
                    onClick={() => setText('')}
                    className="inline-flex items-center gap-1.5 min-h-10 px-2.5 py-1.5 text-xs rounded-md border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50"
                    title="Clear"
                  >
                    <Eraser size={12} /> Clear
                  </button>
                )}
              </div>
            </div>
            <textarea
              id="rr-text"
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder="Paste an article, email, briefing, or any prose…"
              className="w-full bg-port-bg border border-port-border rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 font-mono focus:outline-none focus:border-port-accent/60"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500">
              <span>
                {wordCount} word{wordCount === 1 ? '' : 's'} · approx {estSec}s at {wpm} WPM
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              <label className="text-xs text-gray-400"><span className="sr-only">Shelf title</span><input value={saveTitle} onChange={(event) => setSaveTitle(event.target.value)} placeholder="Title to save" className="w-full min-h-10 bg-port-bg border border-port-border rounded-md px-3" /></label>
              <button type="button" disabled={savingShelf || !documentText || !saveTitle.trim()} onClick={saveToShelf} className="inline-flex justify-center items-center gap-1 min-h-10 border border-port-accent/50 text-port-accent rounded-md disabled:opacity-40"><Save size={14} /> Save to shelf</button>
              <label className="sm:col-span-2 text-xs text-gray-400 flex flex-col sm:flex-row gap-2"><span className="sr-only">URL to add to shelf</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/article" className="flex-1 min-h-10 bg-port-bg border border-port-border rounded-md px-3" /><button type="button" disabled={fetchingShelf || !url.trim()} onClick={fetchToShelf} className="min-h-10 px-3 border border-port-accent/50 text-port-accent rounded-md disabled:opacity-40">Fetch URL to shelf</button></label>
            </div>
          </div>

          <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
            <div className="text-sm font-medium text-gray-300">Settings</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <label className="flex flex-col gap-1.5 text-xs text-gray-400">
                <span>Words per minute</span>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={100}
                    max={1000}
                    step={25}
                    value={wpm}
                    onChange={(e) => setWpm(Number(e.target.value))}
                    className="flex-1 accent-port-accent"
                  />
                  <span className="font-mono text-sm text-gray-200 w-12 text-right">{wpm}</span>
                </div>
              </label>

              <div className="flex flex-col gap-1.5 text-xs text-gray-400">
                <span>Chunk size</span>
                <div className="flex border border-port-border rounded-md overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setChunkSize(1)}
                    className={`flex-1 min-h-10 px-3 text-sm ${chunkSize === 1 ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
                  >
                    1 word
                  </button>
                  <button
                    type="button"
                    onClick={() => setChunkSize(2)}
                    className={`flex-1 min-h-10 px-3 text-sm border-l border-port-border ${chunkSize === 2 ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
                  >
                    2 words
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5 text-xs text-gray-400">
                <span>Focal color</span>
                <div className="flex gap-2 flex-wrap">
                  {focalPalette.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setFocalColor(c.value)}
                      title={c.label}
                      aria-label={`Focal ${c.label}`}
                      className={`w-9 h-9 rounded-md border-2 transition-colors ${focalColor === c.value ? 'border-white' : 'border-port-border hover:border-gray-400'}`}
                      style={{ backgroundColor: c.value }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => startAt(0)}
              disabled={!text.trim()}
              className="inline-flex items-center gap-2 min-h-10 px-4 py-2 rounded-lg bg-port-accent text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/90"
            >
              <Zap size={16} /> Start reading
            </button>
            <button
              type="button"
              onClick={() => startAt(rapidReaderWordIndexAtCursor(text, textareaRef.current?.selectionStart || 0))}
              disabled={!documentText}
              className="inline-flex items-center gap-2 min-h-10 px-4 py-2 rounded-lg border border-port-accent/50 text-port-accent font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/10"
            >
              <Play size={16} /> Start at cursor
            </button>
            {bookmark && (
              <>
                <button
                  type="button"
                  onClick={() => startAt(bookmark.wordIndex, bookmark)}
                  className="inline-flex items-center gap-2 min-h-10 px-4 py-2 rounded-lg border border-port-border text-gray-200 font-medium hover:border-port-accent/60 hover:bg-port-bg/40"
                >
                  <Bookmark size={16} className="text-port-accent" /> Resume at word {bookmark.wordIndex + 1}
                </button>
                <button
                  type="button"
                  onClick={() => { clearRapidReaderProgress(documentText, documentIdentity); setBookmark(null); }}
                  className="min-h-10 px-3 py-2 text-xs text-gray-500 hover:text-white"
                >
                  Clear bookmark
                </button>
              </>
            )}
            <span className="text-xs text-gray-500">
              Tip: many surfaces in PortOS expose a Rapid Read button — Briefing, Wiki notes, and more.
            </span>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
