import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, ChevronLeft, ChevronRight, Mic, MicOff, RefreshCw, Save, Volume2, Settings,
  Plus, Trash2, CloudUpload, Menu, X
} from 'lucide-react';
import * as api from '../../../services/api';
import { getNotesVaults } from '../../../services/apiNotes';
import toast from '../../ui/Toast';
import { onVoiceEvent, sendText, setDictation as setVoiceDictation } from '../../../services/voiceClient';

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
const localToday = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const shiftDate = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export default function DailyLogTab() {
  const [date, setDate] = useState(localToday());
  // Backend today — resolved via GET /daily-log/today on mount so the
  // "Today" button, disabled-forward-nav check, and isToday chip all match
  // the server's timezone. Falls back to localToday() until fetched.
  const [serverToday, setServerToday] = useState(localToday());
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorRef = useRef(null);
  // Ref mirror of the dirty flag so the socket event handler can check it
  // without adding `content`/`entry` to the effect's dependency list
  // (which would re-subscribe on every keystroke).
  const dirtyRef = useRef(false);
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
  dirtyRef.current = dirty;

  const loadEntry = useCallback(async (d, { silent = false } = {}) => {
    if (!silent) setLoading(true);
    const reqId = ++loadRequestRef.current;
    const res = await api.getDailyLog(d).catch(() => null);
    if (reqId !== loadRequestRef.current) return;
    const data = res?.entry || null;
    setEntry(data);
    setContent(data?.content || '');
    if (!silent) setLoading(false);
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await api.listDailyLogs({ limit: 60 }).catch(() => null);
    setHistory(res?.records || []);
  }, []);

  const loadSettings = useCallback(async () => {
    const [s, v] = await Promise.all([
      api.getDailyLogSettings().catch(() => null),
      getNotesVaults().catch(() => []),
    ]);
    if (s) setSettings(s);
    setVaults(v || []);
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
  useEffect(() => {
    let cancelled = false;
    api.getDailyLog('today').then((res) => {
      if (cancelled || !res?.date) return;
      setServerToday(res.date);
      // If we initialized with a wrong local date, hop to the real one.
      if (date === localToday() && res.date !== date) setDate(res.date);
    }).catch(() => null);
    return () => { cancelled = true; };
    // Only on mount — we intentionally don't re-run when date changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Only sync the textarea when the user has no unsaved edits —
        // otherwise an incoming voice segment would clobber whatever they're
        // in the middle of typing. The entry state still updates so the
        // segment count badge reflects the append.
        if (!dirtyRef.current) {
          setContent((prevContent) => (prevContent
            ? `${prevContent.replace(/\s+$/, '')}\n\n${appendedText}`
            : appendedText));
        } else {
          toast('Voice segment appended while you were editing — save or refresh to see it.', { icon: '📝' });
        }
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

  const applyEntry = (next) => {
    setEntry(next);
    setContent(next.content || '');
    setHistory((prev) => upsertHistory(prev, next));
  };

  const handleSave = async () => {
    setSaving(true);
    const res = await api.updateDailyLog(date, content).catch(() => null);
    setSaving(false);
    if (!res?.entry) {
      toast.error('Save failed');
      return;
    }
    applyEntry(res.entry);
    toast.success('Saved');
  };

  const handleAppend = async () => {
    const text = quickAppend.trim();
    if (!text) return;
    setAppending(true);
    const res = await api.appendDailyLog(date, text, 'text').catch(() => null);
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
    const ok = await api.deleteDailyLog(date).then(() => true, () => false);
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
    const res = await api.syncDailyLogsToObsidian().catch(() => null);
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

  const isToday = date === serverToday;
  const segmentCount = entry?.segments?.length ?? entry?.segmentCount ?? 0;

  const dateLabel = useMemo(() => {
    try {
      return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
    } catch { return date; }
  }, [date]);

  return (
    <div className="flex h-full -m-4 relative" style={{ height: 'calc(100vh - 180px)', minHeight: '420px' }}>
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
        className={`${historyOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 transform transition-transform duration-200 absolute md:static inset-y-0 left-0 z-20 w-[80vw] max-w-xs md:w-64 bg-port-bg md:bg-transparent border-r border-port-border flex flex-col shrink-0`}
      >
        <div className="p-3 border-b border-port-border flex items-center gap-2">
          <BookOpen size={14} className="text-port-accent" />
          <span className="text-sm font-medium text-white">Daily Log</span>
          <button
            onClick={() => setShowSettings((s) => !s)}
            className="ml-auto min-h-[40px] min-w-[40px] flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-port-card"
            title="Daily log settings"
          >
            <Settings size={14} />
          </button>
          <button
            onClick={() => setHistoryOpen(false)}
            className="md:hidden min-h-[40px] min-w-[40px] flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-port-card"
            title="Close history"
          >
            <X size={14} />
          </button>
        </div>

        {showSettings && (
          <div className="p-3 border-b border-port-border space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Obsidian vault (mirror logs)</label>
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
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Folder inside vault</label>
              <input
                type="text"
                value={settings?.obsidianFolder || ''}
                onChange={(e) => setSettings((s) => ({ ...(s || {}), obsidianFolder: e.target.value }))}
                onBlur={(e) => saveSettings({ obsidianFolder: e.target.value })}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
                placeholder="Daily Log"
              />
            </div>
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
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border-b border-port-border">
          <button
            onClick={() => setHistoryOpen(true)}
            className="md:hidden min-h-[40px] min-w-[40px] flex items-center justify-center rounded hover:bg-port-card text-gray-400 hover:text-white"
            title="Show history"
            aria-label="Show history"
          >
            <Menu size={16} />
          </button>
          <button
            onClick={() => setDate(shiftDate(date, -1))}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded hover:bg-port-card text-gray-400 hover:text-white"
            title="Previous day"
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value || serverToday)}
            className="bg-port-bg border border-port-border rounded px-2 min-h-[40px] text-sm text-white"
          />
          <button
            onClick={() => setDate(shiftDate(date, 1))}
            disabled={date >= serverToday}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded hover:bg-port-card text-gray-400 hover:text-white disabled:opacity-30"
            title="Next day"
          >
            <ChevronRight size={16} />
          </button>
          {!isToday && (
            <button
              onClick={() => setDate(serverToday)}
              className="px-3 min-h-[40px] rounded bg-port-card text-xs text-gray-300 hover:text-white"
            >
              Today
            </button>
          )}
          <div className="basis-full md:basis-auto md:flex-1 md:min-w-0">
            <div className="text-white font-medium truncate text-sm md:text-base">{dateLabel}</div>
            <div className="text-xs text-gray-500 truncate">
              {segmentCount} segment{segmentCount === 1 ? '' : 's'}
              {entry?.obsidianPath ? ` · ${entry.obsidianPath}` : ''}
            </div>
          </div>
          <button
            onClick={readBack}
            className="flex items-center gap-1 px-3 min-h-[40px] rounded bg-port-card text-gray-300 text-sm hover:text-white"
            title="Have the voice agent read this log back to you"
            aria-label="Read back"
          >
            <Volume2 size={14} /> <span className="hidden sm:inline">Read back</span>
          </button>
          <button
            onClick={toggleDictation}
            className={`flex items-center gap-1 px-3 min-h-[40px] rounded text-sm ${
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
            className="flex items-center gap-1 px-3 min-h-[40px] rounded bg-port-accent text-white text-sm hover:bg-port-accent/80 disabled:opacity-50"
            aria-label="Save"
          >
            <Save size={14} />
            <span className="hidden sm:inline">{saving ? 'Saving…' : 'Save'}</span>
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={!entry}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded hover:bg-port-card text-gray-400 hover:text-port-error disabled:opacity-30"
            title="Delete this entry"
            aria-label="Delete entry"
          >
            <Trash2 size={14} />
          </button>
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
          <div className="px-3 sm:px-4 py-2 bg-port-error/10 border-b border-port-error/30 flex flex-wrap items-center gap-2 sm:gap-3 text-sm">
            <span className="text-port-error flex-1 min-w-0">Delete the entry for {date} permanently?</span>
            <button onClick={handleDelete} className="px-3 min-h-[40px] rounded bg-port-error text-white text-xs">Delete</button>
            <button onClick={() => setConfirmDelete(false)} className="px-3 min-h-[40px] rounded bg-port-card text-gray-300 text-xs">Cancel</button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
          </div>
        ) : (
          <>
            <textarea
              ref={editorRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
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
