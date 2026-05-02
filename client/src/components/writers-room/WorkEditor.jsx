import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Save, GitCommit, Clock, FileText, Sparkles, ListTree, Sun, Moon } from 'lucide-react';
import toast from '../ui/Toast';
import {
  saveWritersRoomDraft,
  snapshotWritersRoomDraft,
  setWritersRoomActiveDraft,
  updateWritersRoomWork,
} from '../../services/apiWritersRoom';
import { KIND_LABELS, STATUS_LABELS } from './labels';
import { countWords } from '../../utils/formatters';
import AiPanel from './AiPanel';

const SIDEBAR_TABS = [
  { id: 'ai', label: 'AI', Icon: Sparkles },
  { id: 'outline', label: 'Outline', Icon: ListTree },
  { id: 'versions', label: 'Versions', Icon: Clock },
];

const SIDEBAR_WIDTH_KEY = 'wr.sidebarWidth';
const SIDEBAR_DEFAULT = 480;
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX_FRACTION = 0.7; // never let the sidebar eat more than 70% of the work area
const READING_THEME_KEY = 'wr.readingTheme';
function readReadingTheme() {
  if (typeof window === 'undefined') return 'dark';
  const v = window.localStorage.getItem(READING_THEME_KEY);
  return v === 'light' ? 'light' : 'dark';
}

function readSidebarWidth() {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT;
  const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= SIDEBAR_MIN ? n : SIDEBAR_DEFAULT;
}

function persistSidebarWidth(width) {
  try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width))); } catch {}
}

export default function WorkEditor({ work, onChange }) {
  const [body, setBody] = useState(work.activeDraftBody || '');
  const [title, setTitle] = useState(work.title);
  const [sidebarTab, setSidebarTab] = useState('ai');
  // Optimistic mirror of work.status — the dropdown reads this so a status
  // change shows immediately, even before the PATCH round-trip resolves and
  // the parent re-renders with the new prop. Synced from the prop whenever
  // the prop changes (both work-id swap AND any time the parent updates).
  const [status, setStatus] = useState(work.status);
  const [savedBody, setSavedBody] = useState(work.activeDraftBody || '');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  // Rehydrate body/title when the parent swaps the active work OR switches to
  // a different draft version of the same work. Both can change without the
  // work id changing (version-switch keeps work.id, swaps activeDraftVersionId).
  const prevKey = useRef({ id: work.id, draftId: work.activeDraftVersionId });
  useEffect(() => {
    const key = { id: work.id, draftId: work.activeDraftVersionId };
    if (prevKey.current.id === key.id && prevKey.current.draftId === key.draftId) return;
    prevKey.current = key;
    setBody(work.activeDraftBody || '');
    setSavedBody(work.activeDraftBody || '');
    setTitle(work.title);
  }, [work.id, work.activeDraftVersionId, work.activeDraftBody, work.title]);

  // Keep the optimistic status + title in sync with the source of truth —
  // separate from the rehydration effect so a PATCH that comes back via the
  // parent's onChange still updates the input even if no other field moved.
  // The "is the user actively editing" guard isn't needed for status (single
  // click) but title commits on blur, so the user can never be mid-edit when
  // a title prop change arrives.
  useEffect(() => { setStatus(work.status); }, [work.status]);
  useEffect(() => { setTitle(work.title); }, [work.title]);

  const dirty = body !== savedBody;
  const wordCount = useMemo(() => countWords(body), [body]);

  // Skip post-await setState if the editor unmounted (rapid work-switch or
  // page nav while a save / snapshot / status PATCH is in flight).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Refs let the once-bound keydown listener read the freshest body/saving
  // values without re-registering on every keystroke. The savingRef gate is
  // synchronous (unlike the `saving` state which only updates after React
  // re-renders), so rapid Cmd+S key-repeats can't slip past the guard and
  // queue overlapping save requests.
  const savingRef = useRef(false);
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const updated = await saveWritersRoomDraft(work.id, body).catch((err) => {
      if (mountedRef.current) toast.error(`Save failed: ${err.message}`);
      return null;
    });
    savingRef.current = false;
    if (!mountedRef.current) return;
    setSaving(false);
    if (!updated) return;
    setSavedBody(body);
    onChange?.(updated);
    toast.success('Saved');
  };
  const handleSave = () => handleSaveRef.current?.();

  useEffect(() => {
    const onKey = (e) => {
      const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
      if (!isSave) return;
      e.preventDefault();
      handleSaveRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleSnapshot = async () => {
    if (dirty) {
      toast('Save before snapshotting', { icon: '⚠️' });
      return;
    }
    const updated = await snapshotWritersRoomDraft(work.id).catch((err) => {
      if (mountedRef.current) toast.error(`Snapshot failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    onChange?.({ ...updated, activeDraftBody: body });
    toast.success(`Created ${updated.drafts[updated.drafts.length - 1].label}`);
  };

  const commitTitle = async () => {
    if (title === work.title) return;
    const updated = await updateWritersRoomWork(work.id, { title }).catch((err) => {
      if (mountedRef.current) toast.error(`Title save failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    // Adopt the server-normalized title (e.g. trim() applied by the Zod
    // schema) — otherwise `title !== work.title` stays true on every blur
    // and the next focus-out re-PATCHes with the same un-normalized value.
    if (updated.title !== title) setTitle(updated.title);
    onChange?.({ ...updated, activeDraftBody: body });
  };

  const commitStatus = async (next) => {
    if (next === status) return;
    setStatus(next); // optimistic — survives a re-render before the PATCH resolves
    const updated = await updateWritersRoomWork(work.id, { status: next }).catch((err) => {
      if (mountedRef.current) {
        toast.error(`Status save failed: ${err.message}`);
        setStatus(work.status); // roll back on failure
      }
      return null;
    });
    if (updated && mountedRef.current) onChange?.({ ...updated, activeDraftBody: body });
  };

  const switchToDraft = async (draftId) => {
    if (draftId === work.activeDraftVersionId) return;
    if (dirty) {
      // Switching versions while the editor has unsaved edits would discard
      // them when the rehydration effect replaces `body` with the server
      // version. Block the switch and ask the user to settle the buffer.
      toast('Save or snapshot before switching versions', { icon: '⚠️' });
      return;
    }
    const updated = await setWritersRoomActiveDraft(work.id, draftId).catch((err) => {
      if (mountedRef.current) toast.error(`Switch failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    // PATCH /works/:id/versions/:draftId now returns manifest + activeDraftBody
    // in one round-trip, so no separate reload is needed.
    onChange?.(updated);
  };

  const activeDraft = useMemo(
    () => work.drafts?.find((d) => d.id === work.activeDraftVersionId),
    [work.drafts, work.activeDraftVersionId]
  );

  // Drag-to-resize sidebar — width is per-user via localStorage so the choice
  // sticks across reloads. The handle is desktop-only; the mobile stack ignores
  // sidebarWidth (the aside renders as a row beneath the editor).
  const splitRef = useRef(null);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [readingTheme, setReadingTheme] = useState(readReadingTheme);
  const toggleReadingTheme = useCallback(() => {
    setReadingTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      try { window.localStorage.setItem(READING_THEME_KEY, next); } catch {}
      return next;
    });
  }, []);
  // Mirror sidebarWidth into a ref so the once-bound mousemove/mouseup effect
  // reads the freshest value at release time without re-registering on every
  // pixel of drag (200px drag = ~200 add/remove pairs otherwise).
  const sidebarWidthRef = useRef(sidebarWidth);
  useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);
  const dragStartRef = useRef(null);

  const onSplitMouseDown = useCallback((e) => {
    e.preventDefault();
    const containerWidth = splitRef.current?.getBoundingClientRect().width ?? 0;
    dragStartRef.current = { startX: e.clientX, startWidth: sidebarWidthRef.current, containerWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragStartRef.current) return;
      const { startX, startWidth, containerWidth } = dragStartRef.current;
      const max = Math.max(SIDEBAR_MIN + 1, containerWidth * SIDEBAR_MAX_FRACTION);
      // Dragging left grows the right-hand sidebar; dragging right shrinks it.
      const next = Math.min(max, Math.max(SIDEBAR_MIN, startWidth - (e.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      if (!dragStartRef.current) return;
      dragStartRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persistSidebarWidth(sidebarWidthRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // If the component unmounts mid-drag, restore body styles so the page
      // doesn't keep the col-resize cursor / no-select state forever.
      if (dragStartRef.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        dragStartRef.current = null;
      }
    };
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-port-border bg-port-card">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          className="bg-transparent text-lg font-bold text-white border-none focus:outline-none focus:bg-port-bg/50 px-1 rounded flex-1 min-w-[200px]"
          aria-label="Work title"
        />
        <select
          value={status}
          onChange={(e) => commitStatus(e.target.value)}
          className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-300"
          aria-label="Status"
        >
          {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span className="text-xs text-gray-500 px-2 py-1 bg-port-bg/50 rounded">{KIND_LABELS[work.kind]}</span>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className={`flex items-center gap-1 px-3 py-1 text-xs rounded ${
            dirty && !saving ? 'bg-port-accent text-white hover:bg-port-accent/80' : 'bg-port-bg text-gray-500'
          }`}
          title={dirty ? 'Save (Ctrl/Cmd+S)' : 'Up to date'}
        >
          <Save size={12} /> {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        <button
          onClick={handleSnapshot}
          disabled={dirty}
          className="flex items-center gap-1 px-3 py-1 text-xs rounded bg-port-bg border border-port-border text-gray-300 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed"
          title="Snapshot the active draft as a new version"
        >
          <GitCommit size={12} /> Snapshot
        </button>
        <button
          onClick={toggleReadingTheme}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-port-bg border border-port-border text-gray-300 hover:text-white"
          title={readingTheme === 'dark' ? 'Switch to light reading theme' : 'Switch to dark reading theme'}
          aria-label="Toggle reading theme"
          aria-pressed={readingTheme === 'light'}
        >
          {readingTheme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
        </button>
      </div>

      <div ref={splitRef} className="flex-1 flex flex-col lg:flex-row min-h-0">
        <div className="relative min-h-0 flex-1">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Start writing… Use # Chapter, ## Scene, ### Beat headings to outline."
            // The theme system applies `background: var(--port-input-bg) !important`
            // to every textarea, so a regular Tailwind `bg-...` class can't win.
            // Override --port-input-bg inline (the !important rule then resolves
            // to our value), and set the matching text color the same way for
            // visual consistency across themes.
            style={readingTheme === 'light'
              ? { '--port-input-bg': 'var(--wr-reading-paper)', color: '#1a1a1a' }
              : undefined}
            className="w-full h-full resize-none px-6 py-6 font-serif text-base leading-relaxed focus:outline-none"
            spellCheck
          />
          <div
            className={`absolute bottom-2 right-3 flex items-center gap-3 text-[11px] px-2 py-1 rounded ${
              readingTheme === 'light' ? 'text-gray-700 bg-[var(--wr-reading-paper)]/85' : 'text-gray-500 bg-port-bg/80'
            }`}
          >
            <span>{wordCount.toLocaleString()} words</span>
            {dirty && <span className="text-port-warning">● unsaved</span>}
          </div>
        </div>

        <div
          onMouseDown={onSplitMouseDown}
          onDoubleClick={() => {
            setSidebarWidth(SIDEBAR_DEFAULT);
            persistSidebarWidth(SIDEBAR_DEFAULT);
          }}
          role="separator"
          aria-label="Resize AI sidebar"
          aria-orientation="vertical"
          title="Drag to resize · double-click to reset"
          className="hidden lg:block w-1 shrink-0 cursor-col-resize bg-port-border hover:bg-port-accent/60 active:bg-port-accent transition-colors"
        />

        <aside
          style={{ '--sidebar-w': `${sidebarWidth}px` }}
          className="border-t lg:border-t-0 border-port-border bg-port-card/60 flex flex-col text-xs min-h-0 w-full lg:w-[var(--sidebar-w)] lg:shrink-0">
          <div className="flex border-b border-port-border bg-port-bg/40">
            {SIDEBAR_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setSidebarTab(id)}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-2 text-[11px] border-b-2 ${
                  sidebarTab === id
                    ? 'border-port-accent text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
                aria-pressed={sidebarTab === id}
              >
                <Icon size={11} /> {label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3">
            {sidebarTab === 'ai' && (
              <AiPanel
                work={work}
                readingTheme={readingTheme}
                onApplyFormat={(text) => {
                  // Don't autosave — keeps a bad format pass from overwriting
                  // the on-disk draft without an explicit Save.
                  setBody(text);
                  toast('Applied to editor — save to persist', { icon: '💾' });
                }}
              />
            )}
            {sidebarTab === 'outline' && (
              <ul className="space-y-0.5">
                {(activeDraft?.segmentIndex || []).map((seg) => (
                  <li key={seg.id} className="flex items-center gap-1 text-gray-400 truncate">
                    <FileText size={10} className="shrink-0" />
                    <span className={`truncate ${seg.kind === 'chapter' ? 'text-white' : seg.kind === 'scene' ? 'text-gray-300' : 'pl-3'}`}>
                      {seg.heading}
                    </span>
                    <span className="ml-auto text-[10px] text-gray-600">{seg.wordCount}</span>
                  </li>
                ))}
                {(!activeDraft?.segmentIndex || activeDraft.segmentIndex.length === 0) && (
                  <li className="text-gray-600 italic">No segments yet — use # Chapter / ## Scene headings to outline.</li>
                )}
              </ul>
            )}
            {sidebarTab === 'versions' && (
              <ul className="space-y-1">
                {(work.drafts || []).slice().reverse().map((draft) => {
                  const isActive = draft.id === work.activeDraftVersionId;
                  return (
                    <li key={draft.id}>
                      <button
                        onClick={() => switchToDraft(draft.id)}
                        className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-left ${
                          isActive ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:bg-port-bg hover:text-white'
                        }`}
                      >
                        <span className="flex items-center gap-1 truncate">
                          <Clock size={10} />
                          {draft.label}
                        </span>
                        <span className="text-[10px] text-gray-500">{draft.wordCount}w</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
