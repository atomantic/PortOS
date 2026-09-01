import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useUrlParams from '../../../hooks/useUrlParams';
import {BookOpen, ChevronLeft, ChevronRight, Mic, MicOff, Save, Volume2, Settings,
  Plus, Trash2, CloudUpload, Menu, X, Sparkles} from 'lucide-react';
import * as api from '../../../services/api';
import { getNotesVaults } from '../../../services/apiNotes';
import toast from '../../ui/Toast';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import { FormField } from '../../ui/FormField';
import OverflowMenu from '../../ui/OverflowMenu';
import { onVoiceEvent, sendText, setDictation as setVoiceDictation } from '../../../services/voiceClient';
import BrailleSpinner from '../../BrailleSpinner';
import useMounted from '../../../hooks/useMounted';
import { useVisibilityEvent } from '../../../hooks/useVisibilityEvent';
import { formatDateFull, localDateKey, shiftISODate } from '../../../utils/formatters';

// Autosave cadence. The debounce keeps us from PUTting on every keystroke;
// the max-wait ceiling exists because a pure debounce never fires at all
// during a long uninterrupted typing run — the whole entry would sit unsaved
// until the user paused.
const AUTOSAVE_DEBOUNCE_MS = 1500;
const AUTOSAVE_MAX_WAIT_MS = 10000;

// Slim shape kept in the sidebar history list — full `content`/`segments`
// would accumulate as the log grows and the sidebar never renders them.
const toHistorySummary = (entry) => ({
  id: entry.id,
  date: entry.date,
  updatedAt: entry.updatedAt,
  obsidianPath: entry.obsidianPath || null,
  segmentCount: typeof entry.segmentCount === 'number'
    ? entry.segmentCount
    : (Array.isArray(entry.segments) ? entry.segments.length : 0),
});

const upsertHistory = (prev, entry) => {
  const summary = toHistorySummary(entry);
  const others = prev.filter((h) => h.date !== summary.date);
  return [summary, ...others].sort((a, b) => b.date.localeCompare(a.date));
};

// ISO YYYY-MM-DD fallback — browser local timezone. Used only as an initial
// value before the backend responds with its canonical "today" (which honors
// the user's configured timezone, so remote/VPN access doesn't desync the
// day). Replaced on mount via a GET /daily-log/today.
// Append a dictated/typed segment to free-form journal text. Idempotent when
// the segment text is already present (socket replay / double-fire). Shared by
// the live socket path and the 409-retry merge so both stay byte-identical.
export const appendJournalSegment = (content, text) => {
  if (typeof text !== 'string' || text.length === 0) return content || '';
  const prev = content || '';
  if (prev.includes(text)) return prev;
  return prev ? `${prev.replace(/\s+$/, '')}\n\n${text}` : text;
};

// Re-apply any voice segments the server holds that the local body is missing
// — the recovery path after a STALE_JOURNAL 409 (an append landed while a PUT
// was in flight). Only `source === 'voice'` segments are folded in: concurrent
// typed/edit segments are already reflected in server content, and replaying
// them would duplicate free-form edits. When local is empty we fall back to
// the server body wholesale so a blank client still adopts remote state.
export const mergeMissingVoiceSegments = (localContent, serverEntry) => {
  let next = localContent || '';
  const segs = Array.isArray(serverEntry?.segments) ? serverEntry.segments : [];
  for (const seg of segs) {
    if (seg?.source === 'voice' && typeof seg.text === 'string' && seg.text) {
      next = appendJournalSegment(next, seg.text);
    }
  }
  if (!next && serverEntry?.content) return serverEntry.content;
  return next;
};

// Max PUT attempts per save (1 initial + retries). Each STALE_JOURNAL folds in
// voice segments the concurrent write added and advances the ifMatch clock.
// Cap is small: voice bursts are short, and the next autosave tick retries
// whatever is still dirty if we exhaust the budget mid-burst.
const STALE_JOURNAL_MAX_ATTEMPTS = 3;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function DailyLogTab() {
  // The URL is the source of truth for the open day (?date=YYYY-MM-DD) — the
  // On This Day widget and shared links deep-link a specific past day; without
  // the param the tab shows the server's today.
  const [searchParams, updateParams] = useUrlParams();
  // Backend today — resolved via GET /daily-log/today on mount so the
  // "Today" button, disabled-forward-nav check, and isToday chip all match
  // the server's timezone. Falls back to localDateKey() until fetched.
  const [serverToday, setServerToday] = useState(localDateKey());
  const dateParam = searchParams.get('date');
  const date = dateParam && ISO_DATE_RE.test(dateParam) ? dateParam : serverToday;
  // Navigating to today clears the param so the default view keeps a clean
  // URL. Ref-read so the setter stays referentially stable for the voice-event
  // handlers that capture it.
  const serverTodayRef = useRef(serverToday);
  serverTodayRef.current = serverToday;
  const setDate = useCallback((next) => {
    updateParams({ date: next === serverTodayRef.current ? null : next }, { replace: true });
  }, [updateParams]);
  const [entry, setEntry] = useState(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [quickAppend, setQuickAppend] = useState('');
  const [appending, setAppending] = useState(false);
  const [history, setHistory] = useState([]);
  const [dictation, setDictation] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(null);
  const [vaults, setVaults] = useState([]);
  // Activity-digest (auto-draft) config + provider list for the picker (#2155).
  const [digestSettings, setDigestSettings] = useState(null);
  const [providers, setProviders] = useState([]);
  const [drafting, setDrafting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorRef = useRef(null);
  const mountedRef = useMounted();
  // Single-flight gate. `saving` state lags re-renders, so the debounce timer
  // and a blur flush can otherwise both fire a PUT for the same content.
  const savingRef = useRef(false);
  // Ref-stashed so the debounce effect, blur, visibilitychange, and Cmd+S all
  // drive one save without re-subscribing on every keystroke.
  const saveRef = useRef(null);
  // Anchors the max-wait ceiling: when the current run of unsaved edits began.
  const firstDirtyAtRef = useRef(null);
  // Suppresses repeat failure toasts — a failing autosave retries on the next
  // keystroke, so an unreachable server would otherwise toast every tick.
  const autoSaveFailedRef = useRef(false);
  // The body of the last FAILED save. The autosave effect refuses to re-arm
  // while `content` still equals it — without this, a failed PUT flips
  // `saving`, the effect re-runs, and an unreachable server gets a silent
  // PUT every debounce tick. Cleared on success; a keystroke (content change),
  // explicit save, or blur/visibility flush still retries.
  const lastFailedBodyRef = useRef(null);
  // Which date the text in `content` actually belongs to. `date` flips before
  // the new entry loads, so this is the only safe answer to "what am I about
  // to overwrite?" — see the guard in saveRef.
  const loadedDateRef = useRef(null);
  // Monotonic counter of outstanding loadEntry() calls so an older fetch
  // resolving after a newer one can't overwrite the entry state for the
  // wrong date (common when prev/next is mashed or the server-today fetch
  // lands after the user has already picked a different date).
  const loadRequestRef = useRef(0);
  // Tracks the dictation state the user just requested (null when idle).
  // Set by toggleDictation; consumed by the voice:dictation echo handler to
  // fire the success toast, or by the voice:error handler to revert and
  // surface a failure toast. Without this, clicking toggle while voice is
  // disabled would show an optimistic "Dictation on" that never actually
  // happened on the server.
  const pendingDictationRef = useRef(null);

  const dirty = content !== (entry?.content || '');

  const loadEntry = useCallback(async (d, { silent = false } = {}) => {
    if (!silent) setLoading(true);
    const reqId = ++loadRequestRef.current;
    const res = await api.getDailyLog(d).catch(() => null);
    if (reqId !== loadRequestRef.current) return;
    const data = res?.entry || null;
    loadedDateRef.current = d;
    setEntry(data);
    setContent(data?.content || '');
    if (!silent) setLoading(false);
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await api.listDailyLogs({ limit: 60 }).catch(() => null);
    setHistory(res?.records || []);
  }, []);

  const loadSettings = useCallback(async () => {
    const [s, v, d, p] = await Promise.all([
      api.getDailyLogSettings().catch(() => null),
      getNotesVaults().catch(() => []),
      api.getActivityDigestSettings().catch(() => null),
      api.getProviders({ silent: true }).catch(() => null),
    ]);
    if (s) setSettings(s);
    setVaults(v || []);
    if (d) setDigestSettings(d);
    setProviders(p?.providers || (Array.isArray(p) ? p : []));
  }, []);

  useEffect(() => { loadEntry(date); }, [date, loadEntry]);
  useEffect(() => { loadHistory(); loadSettings(); }, [loadHistory, loadSettings]);

  // Keep the server's dictation target date aligned with the UI while
  // dictation is active — otherwise navigating to an earlier day (prev/next
  // button, date picker) would still route new voice utterances into the
  // day that was active when the user toggled dictation on.
  useEffect(() => {
    if (dictation) setVoiceDictation(true, date);
  }, [date, dictation]);

  // Ask the server for its canonical "today" so a user in a different timezone
  // than the browser (remote/VPN access) doesn't open the tab on the wrong day.
  // No explicit hop needed: with no ?date= param, `date` derives from
  // serverToday and follows it the moment this resolves.
  useEffect(() => {
    let cancelled = false;
    api.getDailyLog('today').then((res) => {
      if (cancelled || !res?.date) return;
      setServerToday(res.date);
    }).catch(() => null);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Server sends only the delta ({date, text, segment, segmentCount,
    // updatedAt}) — patch local state to avoid repeatedly shipping the
    // full entry over the socket as the day grows.
    const onAppend = (payload) => {
      if (!payload?.date || typeof payload.text !== 'string') return;
      const { date: appendedDate, text: appendedText, segment, segmentCount, updatedAt } = payload;
      // Full-entry patch — used for the right-hand editor/preview where
      // `segments[]` and `content` must be present. Safe against either a
      // summary-only previous state or a full entry.
      const patchFullEntry = (prev) => {
        if (!prev || prev.date !== appendedDate) {
          return {
            date: appendedDate,
            content: appendedText,
            segments: segment ? [segment] : [],
            segmentCount: segmentCount ?? (segment ? 1 : 0),
            updatedAt: updatedAt || prev?.updatedAt,
            obsidianPath: prev?.obsidianPath || null,
          };
        }
        const nextContent = prev.content
          ? `${prev.content.replace(/\s+$/, '')}\n\n${appendedText}`
          : appendedText;
        const nextSegments = segment ? [...(prev.segments || []), segment] : (prev.segments || []);
        return {
          ...prev,
          content: nextContent,
          segments: nextSegments,
          segmentCount: segmentCount ?? nextSegments.length,
          updatedAt: updatedAt || prev.updatedAt,
        };
      };
      setHistory((prev) => {
        const existing = prev.find((h) => h.date === appendedDate);
        // Sidebar entries are summaries — only carry metadata, not content.
        // Patch just what the sidebar renders (segmentCount, updatedAt,
        // obsidianPath) to keep memory and renders cheap.
        const patched = existing
          ? { ...existing, segmentCount: segmentCount ?? (existing.segmentCount ?? 0) + 1, updatedAt: updatedAt || existing.updatedAt }
          : {
              date: appendedDate,
              segmentCount: segmentCount ?? 1,
              updatedAt: updatedAt || new Date().toISOString(),
              obsidianPath: null,
            };
        return upsertHistory(prev, patched);
      });
      if (appendedDate === date) {
        setEntry((prev) => patchFullEntry(prev));
        // Always fold the segment into the textarea — including when the user
        // has unsaved edits. Replacing wholesale used to drop typed text; the
        // previous fix parked autosave instead, which left the segment invisible
        // until Save/refresh and still lost it if a PUT was already in flight.
        // Append-at-end keeps mid-entry typing intact; restore the caret so a
        // controlled-textarea re-render doesn't jump the cursor to the end.
        setContent((prevContent) => {
          const next = appendJournalSegment(prevContent, appendedText);
          const el = editorRef.current;
          // Only restore caret when the control is focused and reports a real
          // selection (detached/non-textarea nodes leave selectionStart undefined).
          if (
            el
            && document.activeElement === el
            && next !== prevContent
            && typeof el.selectionStart === 'number'
            && typeof el.selectionEnd === 'number'
          ) {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            queueMicrotask(() => {
              if (editorRef.current === el) {
                try { el.setSelectionRange(start, end); } catch { /* detached */ }
              }
            });
          }
          return next;
        });
      }
    };
    const onDictation = (payload) => {
      const nextEnabled = !!payload?.enabled;
      setDictation((prev) => (prev === nextEnabled ? prev : nextEnabled));
      if (payload?.date && payload.date !== date) setDate(payload.date);
      // If this echo is the server's response to a user-initiated toggle,
      // confirm success with the appropriate toast. Voice-tool-initiated
      // changes (no pending ref set) are confirmed by the CoS reply, so
      // we stay quiet.
      const requested = pendingDictationRef.current;
      if (requested !== null && nextEnabled === requested) {
        pendingDictationRef.current = null;
        if (nextEnabled) {
          toast('Dictation on — speak your log. Say "stop dictation" to end.', { icon: '🎙️' });
        } else {
          toast('Dictation off.', { icon: '🔇' });
        }
      }
    };
    // A voice:error with stage='dictation' while a toggle is in flight
    // means the server rejected the change (most commonly: voice mode is
    // disabled). Revert the optimistic local state and surface a failure
    // toast. Unrelated voice:error stages (turn/text) are handled by the
    // VoiceWidget's own listener — don't clobber our pending dictation
    // state on those.
    const onVoiceError = (err) => {
      if (pendingDictationRef.current !== null && err?.stage === 'dictation') {
        pendingDictationRef.current = null;
        setDictation(false);
        toast.error('Voice mode is disabled — can\'t enter dictation. Enable it in Settings → Voice.');
      }
    };
    const offs = [
      onVoiceEvent('voice:dailyLog:appended', onAppend),
      onVoiceEvent('voice:dictation', onDictation),
      onVoiceEvent('voice:error', onVoiceError),
    ];
    return () => offs.forEach((off) => off());
  }, [date]);

  // Adopt the server's entry wholesale, textarea included.
  const applyEntry = (next) => {
    setEntry(next);
    setContent(next.content || '');
    setHistory((prev) => upsertHistory(prev, next));
  };

  // One PUT attempt. Returns `{ entry }`, `{ stale, entry }` on concurrency
  // conflict, or null on transport/other failure. Never toasts — the caller
  // owns failure UX so auto vs explicit saves can differ.
  const putDailyLog = async (targetDate, body, ifMatchUpdatedAt) => {
    try {
      return await api.updateDailyLog(targetDate, body, {
        silent: true,
        ...(ifMatchUpdatedAt ? { ifMatchUpdatedAt } : {}),
      });
    } catch (err) {
      if (err?.code === 'STALE_JOURNAL' && err.context?.entry) {
        return { stale: true, entry: err.context.entry };
      }
      return null;
    }
  };

  // Reassigned every render so it always closes over fresh `content`/`date`
  // without the callers needing it in a dependency list.
  saveRef.current = async ({ auto = false } = {}) => {
    if (savingRef.current || !dirty) return;
    // `content` belongs to loadedDateRef, not necessarily `date`: changing the
    // day flips `date` immediately while the new entry is still loading.
    // Saving in that window would write this day's text into another day.
    if (loadedDateRef.current !== date) return;
    const targetDate = date;
    let body = content;
    // Optimistic concurrency token — the last entry.updatedAt we observed.
    // Voice appends advance it server-side; a PUT with a stale token 409s so
    // we can fold the segment in and retry instead of clobbering it.
    let ifMatch = entry?.updatedAt || null;
    savingRef.current = true;
    // Anchor the ceiling at attempt time, not on success: resetting it only
    // after a successful PUT would leave `waited` past the ceiling forever
    // once a save failed, collapsing the debounce into a PUT per keystroke
    // against an already-unhealthy server.
    firstDirtyAtRef.current = null;
    setSaving(true);
    // Bounded stale-retry loop: each 409 folds in voice segments the concurrent
    // write added, advances the ifMatch clock, and re-PUTs. Exhausting the
    // budget falls through as failure — content stays dirty so the next
    // autosave tick (or explicit Save) retries with a fresh clock.
    let res = null;
    for (let attempt = 0; attempt < STALE_JOURNAL_MAX_ATTEMPTS; attempt += 1) {
      res = await putDailyLog(targetDate, body, ifMatch);
      if (!res?.stale) break;
      if (attempt === STALE_JOURNAL_MAX_ATTEMPTS - 1) break;
      const serverEntry = res.entry;
      body = mergeMissingVoiceSegments(body, serverEntry);
      ifMatch = serverEntry.updatedAt || null;
      if (loadedDateRef.current === targetDate && mountedRef.current) {
        setEntry(serverEntry);
        setHistory((prev) => upsertHistory(prev, serverEntry));
        // Fold the segment into the live textarea too when the user hasn't
        // typed past the body we just tried to save.
        setContent((prev) => (prev === content
          ? body
          : mergeMissingVoiceSegments(prev, serverEntry)));
      }
    }
    savingRef.current = false;
    if (!mountedRef.current) return;
    setSaving(false);
    if (!res?.entry || res.stale) {
      if (!auto || !autoSaveFailedRef.current) toast.error('Save failed');
      autoSaveFailedRef.current = true;
      lastFailedBodyRef.current = body;
      return;
    }
    autoSaveFailedRef.current = false;
    lastFailedBodyRef.current = null;
    // Adopt the server's metadata but deliberately leave the textarea alone
    // when the user typed during the in-flight PUT — those keystrokes stay in
    // `content` and stay dirty against res.entry.content, so the next tick
    // saves them. applyEntry() would revert them to the server's echo.
    if (loadedDateRef.current === targetDate) {
      setEntry(res.entry);
      setHistory((prev) => upsertHistory(prev, res.entry));
    }
    if (!auto) toast.success('Saved');
  };

  const handleSave = () => saveRef.current?.();

  // Autosave. Re-arms on every render whose deps moved: each keystroke
  // restarts the debounce, and `saving` flipping back to false re-checks for
  // work that arrived mid-PUT (or was skipped by the single-flight gate).
  useEffect(() => {
    if (!dirty || loadedDateRef.current !== date) {
      firstDirtyAtRef.current = null;
      return undefined;
    }
    // A body that just failed doesn't get an automatic re-attempt — that loops
    // a PUT per debounce tick against a down server. Wait for a content change
    // (or an explicit save / blur / visibility flush, which bypass this effect).
    if (lastFailedBodyRef.current !== null && content === lastFailedBodyRef.current) {
      firstDirtyAtRef.current = null;
      return undefined;
    }
    if (firstDirtyAtRef.current === null) firstDirtyAtRef.current = Date.now();
    const waited = Date.now() - firstDirtyAtRef.current;
    const wait = Math.max(0, Math.min(AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS - waited));
    const timer = setTimeout(() => saveRef.current?.({ auto: true }), wait);
    return () => clearTimeout(timer);
  }, [content, dirty, saving, date]);

  // Flush when the tab/app is backgrounded. Mobile browsers can freeze or
  // discard the page without firing blur on the textarea, so the pending
  // debounce timer would never run.
  useVisibilityEvent((state) => {
    if (state === 'hidden') saveRef.current?.({ auto: true });
  });

  // Flush on unmount (tab switch, route change). The debounce timer is cleared
  // by its own cleanup, so without this any edit still inside the debounce
  // window is silently dropped. The in-flight PUT outlives the component; its
  // post-await setState is already gated on mountedRef.
  useEffect(() => () => { saveRef.current?.({ auto: true }); }, []);

  const handleAppend = async () => {
    const text = quickAppend.trim();
    if (!text) return;
    setAppending(true);
    const res = await api.appendDailyLog(date, text, 'text', { silent: true }).catch(() => null);
    setAppending(false);
    if (!res?.entry) {
      toast.error('Append failed');
      return;
    }
    applyEntry(res.entry);
    setQuickAppend('');
  };

  const toggleDictation = () => {
    const next = !dictation;
    // Optimistic local flip for responsive UI; the success toast waits for
    // the server echo (voice:dictation) and a voice:error revert will undo
    // this if the server rejected the change (e.g. voice mode disabled).
    pendingDictationRef.current = next;
    setDictation(next);
    setVoiceDictation(next, date);
  };

  // Route the read-back through the voice assistant so its TTS pipeline fires
  // — the browser TTS APIs would skip the project's Kokoro/Piper voice.
  //
  // The socket's MAX_TEXT_LEN cap (4000 chars) would reject any reasonably
  // full log if we inlined the content, so for long entries we delegate to
  // the daily_log_read tool and let the LLM speak the server-returned body.
  // Short logs still get inlined so the model can't add commentary or
  // accidentally skip content by summarizing the tool result.
  const READ_BACK_INLINE_LIMIT = 3800; // leaves room for prompt scaffolding under MAX_TEXT_LEN
  const readBack = () => {
    const body = content.trim();
    if (!body) {
      toast('Daily log is empty.', { icon: '📖' });
      return;
    }
    if (body.length <= READ_BACK_INLINE_LIMIT) {
      sendText(`Read this back to me verbatim, exactly as written, with no commentary:\n\n${body}`);
    } else {
      sendText(`Use the daily_log_read tool for ${date} and speak the full returned content aloud verbatim — no summarization, no commentary, just read it exactly as written.`);
    }
  };

  const handleDelete = async () => {
    const ok = await api.deleteDailyLog(date, { silent: true }).then(() => true, () => false);
    if (!ok) {
      toast.error('Delete failed');
      return;
    }
    toast.success('Deleted');
    setConfirmDelete(false);
    setEntry(null);
    setContent('');
    setHistory((prev) => prev.filter((h) => h.date !== date));
  };

  const handleSyncObsidian = async () => {
    setSyncing(true);
    const res = await api.syncDailyLogsToObsidian({ silent: true }).catch(() => null);
    setSyncing(false);
    if (res) toast.success(`Synced ${res.synced} entries to Obsidian`);
    else toast.error('Sync failed');
  };

  const saveSettings = async (partial) => {
    const next = await api.updateDailyLogSettings(partial).catch(() => null);
    if (next) {
      setSettings(next);
      toast.success('Settings saved');
    }
  };

  const saveDigestSettings = async (partial) => {
    // Optimistic local merge so the control reflects the change immediately;
    // the server response is authoritative and replaces it on success.
    setDigestSettings((prev) => ({ ...(prev || {}), ...partial }));
    const next = await api.updateActivityDigestSettings(partial).catch(() => null);
    if (next) {
      setDigestSettings(next);
      toast.success('Digest settings saved');
    }
  };

  const handleDraft = async () => {
    // The draft splices its section into the SERVER's persisted entry, so
    // unsaved edits in the textarea would be clobbered by the returned content.
    // Make the user save (or discard) first rather than silently losing them.
    if (dirty) {
      toast('Save or discard your edits before drafting.', { icon: '📝' });
      return;
    }
    setDrafting(true);
    const res = await api.draftActivityDigest(date, { silent: true }).catch(() => null);
    setDrafting(false);
    if (!res) {
      toast.error('Draft failed');
      return;
    }
    if (res.entry) applyEntry(res.entry);
    if (res.drafted) {
      toast.success(res.usedLlm ? 'Drafted with AI narrative' : 'Drafted from your timeline');
    } else {
      toast('No tracked activity for this day yet.', { icon: '🗓️' });
    }
  };

  // The provider whose id is currently configured — used to name it in the UI
  // (AI policy: the surface that can trigger LLM work must name the provider).
  const digestProvider = providers.find((p) => p.id === digestSettings?.provider) || null;

  const isToday = date === serverToday;
  const segmentCount = entry?.segments?.length ?? entry?.segmentCount ?? 0;

  // Autosave is silent, so the toolbar carries the feedback the toast used to.
  const saveStatus = saving ? 'Saving…'
    : dirty ? 'Unsaved…'
    : entry ? 'Saved' : '';

  // formatDateFull anchors a bare YYYY-MM-DD at LOCAL midnight and falls back
  // to '' on an unparseable value, so a malformed route param still renders.
  const dateLabel = useMemo(() => formatDateFull(date) || date, [date]);

  // AI policy: the surface that can trigger LLM work names the provider, so the
  // overflow menu item and the sm+ button share one title string.
  const draftTitle = digestProvider
    ? `Draft an activity-digest section for this day using ${digestProvider.name || digestProvider.id}`
    : 'Draft an activity-digest section for this day (structured summary — no AI provider)';

  // Under `sm` these three drop out of the toolbar row and live here instead —
  // still reachable, just not costing a wrapped row each (#3526).
  const mobileToolbarActions = [
    { id: 'draft', label: drafting ? 'Drafting…' : 'Draft activity digest', icon: Sparkles, disabled: drafting, onSelect: handleDraft },
    { id: 'read-back', label: 'Read back', icon: Volume2, onSelect: readBack },
    { id: 'delete', label: 'Delete entry', icon: Trash2, tone: 'danger', disabled: !entry, onSelect: () => setConfirmDelete(true) },
  ];

  return (
    <div className="flex h-full min-h-0 relative">
      {/* Left: history + settings. Drawer on mobile, persistent column on md+. */}
      {historyOpen && (
        <button
          type="button"
          aria-label="Close history"
          onClick={() => setHistoryOpen(false)}
          className="md:hidden absolute inset-0 bg-black/50 z-10"
        />
      )}
      <div
        className={`${historyOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 transform transition-transform duration-200 absolute md:static inset-y-0 left-0 z-20 w-[80vw] max-w-xs md:w-64 bg-port-bg md:bg-transparent border-r border-port-border flex flex-col min-h-0 shrink-0`}
      >
        <div className="p-3 border-b border-port-border flex items-center gap-2">
          <BookOpen size={14} className="text-port-accent" />
          <span className="text-sm font-medium text-white">Daily Log</span>
          <button
            onClick={() => setShowSettings((s) => !s)}
            className="ml-auto min-h-[40px] min-w-[40px] flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-port-card"
            title="Daily log settings" aria-label="Daily log settings"
          >
            <Settings size={14} />
          </button>
          <button
            onClick={() => setHistoryOpen(false)}
            className="md:hidden min-h-[44px] min-w-[44px] flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-port-card"
            title="Close history" aria-label="Close history"
          >
            <X size={14} />
          </button>
        </div>

        {showSettings && (
          <div className="p-3 border-b border-port-border space-y-3">
            <FormField label="Obsidian vault (mirror logs)" labelClassName="block text-xs text-gray-400 mb-1">
              <select
                value={settings?.obsidianVaultId || ''}
                onChange={(e) => saveSettings({ obsidianVaultId: e.target.value || null })}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
              >
                <option value="">None — PortOS only</option>
                {vaults.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Folder inside vault" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                value={settings?.obsidianFolder || ''}
                onChange={(e) => setSettings((s) => ({ ...(s || {}), obsidianFolder: e.target.value }))}
                onBlur={(e) => saveSettings({ obsidianFolder: e.target.value })}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
                placeholder="Daily Log"
              />
            </FormField>
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={!!settings?.autoSync}
                onChange={(e) => saveSettings({ autoSync: e.target.checked })}
              />
              Auto-mirror to Obsidian on every save
            </label>
            <button
              onClick={handleSyncObsidian}
              disabled={!settings?.obsidianVaultId || syncing}
              className="flex items-center gap-2 w-full px-3 py-1.5 rounded bg-port-card text-gray-300 text-xs hover:text-white hover:bg-port-border disabled:opacity-50"
            >
              <CloudUpload size={12} className={syncing ? 'animate-pulse' : ''} />
              Re-sync all entries now
            </button>
            <p className="text-[10px] text-gray-600">
              Entries embed into the Chief-of-Staff memory system automatically so agents can search
              across daily logs.
            </p>

            <div className="pt-3 border-t border-port-border space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles size={13} className="text-port-accent" />
                <span className="text-xs font-medium text-white">Activity Digest auto-drafts</span>
              </div>
              <p className="text-[10px] text-gray-600">
                Summarizes each day&apos;s activity timeline (conversations, meetings, media) into a
                clearly-marked section of that day&apos;s log. Your typed and dictated text is never
                changed. Runs only when enabled below.
              </p>
              <label htmlFor="digest-enabled" className="flex items-center gap-2 text-xs text-gray-400">
                <input
                  id="digest-enabled"
                  type="checkbox"
                  checked={!!digestSettings?.enabled}
                  onChange={(e) => saveDigestSettings({ enabled: e.target.checked })}
                />
                Enable the scheduled evening draft
              </label>
              <FormField label="AI provider (optional — narrative summary)" labelClassName="block text-xs text-gray-400 mb-1">
                <select
                  id="digest-provider"
                  value={digestSettings?.provider || ''}
                  onChange={(e) => saveDigestSettings({ provider: e.target.value || null })}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
                >
                  <option value="">None — structured summary only (no AI)</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name || p.id}</option>
                  ))}
                </select>
              </FormField>
              {digestProvider && (
                <FormField label="Model (optional)" labelClassName="block text-xs text-gray-400 mb-1">
                  <input
                    id="digest-model"
                    type="text"
                    value={digestSettings?.model || ''}
                    onChange={(e) => setDigestSettings((s) => ({ ...(s || {}), model: e.target.value }))}
                    onBlur={(e) => saveDigestSettings({ model: e.target.value || null })}
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
                    placeholder={digestProvider.defaultModel || 'provider default'}
                  />
                </FormField>
              )}
              <FormField label="Evening run time" labelClassName="block text-xs text-gray-400 mb-1">
                <input
                  id="digest-runtime"
                  type="time"
                  value={digestSettings?.runTime || '21:00'}
                  onChange={(e) => setDigestSettings((s) => ({ ...(s || {}), runTime: e.target.value }))}
                  onBlur={(e) => e.target.value && saveDigestSettings({ runTime: e.target.value })}
                  className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
                />
              </FormField>
              <p className="text-[10px] text-gray-600">
                {digestProvider
                  ? `Scheduled drafts will call ${digestProvider.name || digestProvider.id}. Use the Draft action in the toolbar to run it now.`
                  : 'No AI provider selected — drafts are a deterministic structured summary with zero AI calls.'}
              </p>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {history.length === 0 ? (
            <div className="p-4 text-xs text-gray-500">No entries yet — start today.</div>
          ) : (
            <div className="divide-y divide-port-border/50">
              {history.map((h) => {
                const active = h.date === date;
                return (
                  <button
                    key={h.date}
                    onClick={() => { setDate(h.date); setHistoryOpen(false); }}
                    className={`w-full text-left px-3 py-2 min-h-[44px] hover:bg-port-card/50 ${
                      active ? 'bg-port-accent/10 border-l-2 border-port-accent' : ''
                    }`}
                  >
                    <div className={`text-sm ${active ? 'text-white' : 'text-gray-300'}`}>{h.date}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {(() => { const n = h.segmentCount ?? h.segments?.length ?? 0; return `${n} segment${n === 1 ? '' : 's'}`; })()}
                      {h.obsidianPath ? ' · obsidian' : ''}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: editor */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Two stacked clusters under `sm` (date nav, then label + actions), one
            wrapping row from `sm` up. The old flat `flex-wrap` toolbar spilled
            its 11 controls into 4+ rows on a 375px viewport and pushed the
            textarea below the fold (#3526), so on phones the rarely-used
            actions move into the overflow menu instead of taking a row each. */}
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border-b border-port-border">
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              onClick={() => setHistoryOpen(true)}
              className="md:hidden min-h-[44px] min-w-[44px] sm:min-h-[40px] sm:min-w-[40px] flex items-center justify-center rounded hover:bg-port-card text-gray-400 hover:text-white"
              title="Show history"
              aria-label="Show history"
            >
              <Menu size={16} />
            </button>
            <button
              onClick={() => setDate(shiftISODate(date, -1))}
              className="min-h-[44px] min-w-[44px] sm:min-h-[40px] sm:min-w-[40px] flex items-center justify-center rounded hover:bg-port-card text-gray-400 hover:text-white"
              title="Previous day" aria-label="Previous day"
            >
              <ChevronLeft size={16} />
            </button>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value || serverToday)}
              aria-label="Log date"
              className="min-w-0 bg-port-bg border border-port-border rounded px-2 min-h-[44px] sm:min-h-[40px] text-sm text-white"
            />
            <button
              onClick={() => setDate(shiftISODate(date, 1))}
              disabled={date >= serverToday}
              className="min-h-[44px] min-w-[44px] sm:min-h-[40px] sm:min-w-[40px] flex items-center justify-center rounded hover:bg-port-card text-gray-400 hover:text-white disabled:opacity-30"
              title="Next day" aria-label="Next day"
            >
              <ChevronRight size={16} />
            </button>
            {!isToday && (
              <button
                onClick={() => setDate(serverToday)}
                className="px-3 min-h-[44px] sm:min-h-[40px] rounded bg-port-card text-xs text-gray-300 hover:text-white"
              >
                Today
              </button>
            )}
          </div>
          {/* `sm:flex-1` so on sm+ the date label absorbs the slack and the
              action buttons stay right-aligned, as the flat toolbar rendered
              them; under sm this cluster is simply the second stacked row. */}
          <div className="flex items-center gap-1.5 sm:gap-2 sm:flex-1 min-w-0">
            <div className="flex-1 min-w-0">
              <div className="text-white font-medium truncate text-sm md:text-base">{dateLabel}</div>
              <div className="text-xs text-gray-500 truncate">
                {segmentCount} segment{segmentCount === 1 ? '' : 's'}
                {entry?.obsidianPath ? ` · ${entry.obsidianPath}` : ''}
                {saveStatus ? <span> · {saveStatus}</span> : null}
              </div>
            </div>
            <button
              onClick={handleDraft}
              disabled={drafting}
              className="hidden sm:flex shrink-0 items-center gap-1 px-3 min-h-[40px] rounded bg-port-card text-gray-300 text-sm hover:text-white disabled:opacity-50"
              title={draftTitle}
              aria-label="Draft activity digest"
            >
              <Sparkles size={14} className={drafting ? 'animate-pulse' : ''} />
              <span>{drafting ? 'Drafting…' : 'Draft'}</span>
            </button>
            <button
              onClick={readBack}
              className="hidden sm:flex shrink-0 items-center gap-1 px-3 min-h-[40px] rounded bg-port-card text-gray-300 text-sm hover:text-white"
              title="Have the voice agent read this log back to you"
              aria-label="Read back"
            >
              <Volume2 size={14} /> <span>Read back</span>
            </button>
            <button
              onClick={toggleDictation}
              className={`flex shrink-0 items-center gap-1 px-3 min-h-[44px] min-w-[44px] sm:min-h-[40px] sm:min-w-0 justify-center rounded text-sm ${
                dictation
                  ? 'bg-port-accent text-white animate-pulse'
                  : 'bg-port-card text-gray-300 hover:text-white'
              }`}
              title={dictation ? 'Stop voice dictation' : 'Start voice dictation (voice goes straight into this log)'}
              aria-label={dictation ? 'Stop dictation' : 'Start dictation'}
            >
              {dictation ? <MicOff size={14} /> : <Mic size={14} />}
              <span className="hidden sm:inline">{dictation ? 'Dictating' : 'Dictate'}</span>
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="flex shrink-0 items-center gap-1 px-3 min-h-[44px] min-w-[44px] sm:min-h-[40px] sm:min-w-0 justify-center rounded bg-port-accent text-white text-sm hover:bg-port-accent/80 disabled:opacity-50"
              aria-label="Save"
            >
              <Save size={14} />
              <span className="hidden sm:inline">{saving ? 'Saving…' : 'Save'}</span>
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={!entry}
              className="hidden sm:flex shrink-0 min-h-[40px] min-w-[40px] items-center justify-center rounded hover:bg-port-card text-gray-400 hover:text-port-error disabled:opacity-30"
              title="Delete this entry"
              aria-label="Delete entry"
            >
              <Trash2 size={14} />
            </button>
            <OverflowMenu
              className="sm:hidden shrink-0"
              label="More log actions"
              items={mobileToolbarActions}
            />
          </div>
        </div>

        {dictation && (
          <div className="px-3 sm:px-4 py-2 bg-port-accent/10 border-b border-port-accent/30 text-xs sm:text-sm text-port-accent flex items-start gap-2">
            <Mic size={14} className="animate-pulse shrink-0 mt-0.5" />
            <span>
              Dictation on — speak your log. Say <span className="font-mono">"stop dictation"</span> to end.
              The voice assistant is NOT replying — every utterance appends to this entry.
            </span>
          </div>
        )}

        {confirmDelete && (
          <InlineConfirmRow
            variant="separator"
            question={`Delete the entry for ${date} permanently?`}
            onConfirm={handleDelete}
            onCancel={() => setConfirmDelete(false)}
          />
        )}

        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <BrailleSpinner text="Loading" />
          </div>
        ) : (
          <>
            <textarea
              aria-label="Log entry"
              ref={editorRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onBlur={() => saveRef.current?.({ auto: true })}
              placeholder={isToday
                ? "What's on your mind today? Type freely, append voice segments, or toggle dictation above…"
                : 'This day\'s entry is empty.'}
              className="flex-1 w-full p-3 sm:p-4 bg-port-bg text-gray-200 text-sm resize-none focus:outline-none font-sans"
              spellCheck
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault();
                  if (dirty) handleSave();
                }
              }}
            />
            <form
              onSubmit={(e) => { e.preventDefault(); handleAppend(); }}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border-t border-port-border bg-port-card/30"
            >
              <Plus size={14} className="text-gray-500 shrink-0 hidden sm:block" />
              <input
                type="text"
                value={quickAppend}
                onChange={(e) => setQuickAppend(e.target.value)}
                placeholder="Quick append — adds a new paragraph…"
                aria-label="Quick append a paragraph to the daily log"
                className="flex-1 min-w-0 bg-port-bg border border-port-border rounded px-3 min-h-[40px] text-sm text-white placeholder-gray-500"
              />
              <button
                type="submit"
                disabled={appending || !quickAppend.trim()}
                className="px-3 min-h-[40px] rounded bg-port-accent text-white text-sm disabled:opacity-50"
              >
                {appending ? '…' : 'Append'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
