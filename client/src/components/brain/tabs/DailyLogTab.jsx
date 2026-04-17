import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, ChevronLeft, ChevronRight, Mic, MicOff, RefreshCw, Save, Volume2, Settings,
  Plus, Trash2, CloudUpload
} from 'lucide-react';
import * as api from '../../../services/api';
import { getNotesVaults } from '../../../services/apiNotes';
import toast from '../../ui/Toast';
import { onVoiceEvent, sendText, setDictation as setVoiceDictation } from '../../../services/voiceClient';

const upsertHistory = (prev, entry) => {
  const others = prev.filter((h) => h.date !== entry.date);
  return [entry, ...others].sort((a, b) => b.date.localeCompare(a.date));
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
  const editorRef = useRef(null);
  // Ref mirror of the dirty flag so the socket event handler can check it
  // without adding `content`/`entry` to the effect's dependency list
  // (which would re-subscribe on every keystroke).
  const dirtyRef = useRef(false);

  const dirty = content !== (entry?.content || '');
  dirtyRef.current = dirty;

  const loadEntry = useCallback(async (d, { silent = false } = {}) => {
    if (!silent) setLoading(true);
    const res = await api.getDailyLog(d).catch(() => null);
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
      // Sync local state only. Toasts are owned by the initiator (the UI
      // toggle button handles its own toast; voice-tool-triggered changes
      // flow through the CoS reply which speaks confirmation). An earlier
      // version toasted here on false→true, but under rapid toggles the
      // server echo could arrive after the UI had already flipped state
      // again, firing a stale "Dictation on" — source-of-truth belongs to
      // whoever initiated the change, not the echo.
      setDictation((prev) => (prev === nextEnabled ? prev : nextEnabled));
      if (payload?.date && payload.date !== date) setDate(payload.date);
    };
    const offs = [
      onVoiceEvent('voice:dailyLog:appended', onAppend),
      onVoiceEvent('voice:dictation', onDictation),
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
    setDictation(next);
    setVoiceDictation(next, date);
    if (next) {
      toast('Dictation on — speak your log. Say "stop dictation" to end.', { icon: '🎙️' });
    } else {
      toast('Dictation off.', { icon: '🔇' });
    }
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
    <div className="flex h-full -m-4" style={{ height: 'calc(100vh - 180px)' }}>
      {/* Left: history + settings */}
      <div className="w-64 border-r border-port-border flex flex-col shrink-0">
        <div className="p-3 border-b border-port-border flex items-center gap-2">
          <BookOpen size={14} className="text-port-accent" />
          <span className="text-sm font-medium text-white">Daily Log</span>
          <button
            onClick={() => setShowSettings((s) => !s)}
            className="ml-auto p-1 rounded text-gray-400 hover:text-white hover:bg-port-card"
            title="Daily log settings"
          >
            <Settings size={14} />
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
                    onClick={() => setDate(h.date)}
                    className={`w-full text-left px-3 py-2 hover:bg-port-card/50 ${
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
        <div className="flex items-center gap-2 px-4 py-3 border-b border-port-border">
          <button
            onClick={() => setDate(shiftDate(date, -1))}
            className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-white"
            title="Previous day"
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value || serverToday)}
            className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
          />
          <button
            onClick={() => setDate(shiftDate(date, 1))}
            disabled={date >= serverToday}
            className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-white disabled:opacity-30"
            title="Next day"
          >
            <ChevronRight size={16} />
          </button>
          {!isToday && (
            <button
              onClick={() => setDate(serverToday)}
              className="px-2 py-1 rounded bg-port-card text-xs text-gray-300 hover:text-white"
            >
              Today
            </button>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-white font-medium truncate">{dateLabel}</div>
            <div className="text-xs text-gray-500">
              {segmentCount} segment{segmentCount === 1 ? '' : 's'}
              {entry?.obsidianPath ? ` · ${entry.obsidianPath}` : ''}
            </div>
          </div>
          <button
            onClick={readBack}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-port-card text-gray-300 text-sm hover:text-white"
            title="Have the voice agent read this log back to you"
          >
            <Volume2 size={14} /> Read back
          </button>
          <button
            onClick={toggleDictation}
            className={`flex items-center gap-1 px-3 py-1.5 rounded text-sm ${
              dictation
                ? 'bg-port-accent text-white animate-pulse'
                : 'bg-port-card text-gray-300 hover:text-white'
            }`}
            title={dictation ? 'Stop voice dictation' : 'Start voice dictation (voice goes straight into this log)'}
          >
            {dictation ? <MicOff size={14} /> : <Mic size={14} />}
            {dictation ? 'Dictating' : 'Dictate'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-port-accent text-white text-sm hover:bg-port-accent/80 disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={!entry}
            className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-port-error disabled:opacity-30"
            title="Delete this entry"
          >
            <Trash2 size={14} />
          </button>
        </div>

        {dictation && (
          <div className="px-4 py-2 bg-port-accent/10 border-b border-port-accent/30 text-sm text-port-accent flex items-center gap-2">
            <Mic size={14} className="animate-pulse" />
            Dictation on — speak your log. Say <span className="font-mono">"stop dictation"</span> to end.
            The voice assistant is NOT replying — every utterance appends to this entry.
          </div>
        )}

        {confirmDelete && (
          <div className="px-4 py-2 bg-port-error/10 border-b border-port-error/30 flex items-center gap-3 text-sm">
            <span className="text-port-error">Delete the entry for {date} permanently?</span>
            <button onClick={handleDelete} className="px-2 py-1 rounded bg-port-error text-white text-xs">Delete</button>
            <button onClick={() => setConfirmDelete(false)} className="px-2 py-1 rounded bg-port-card text-gray-300 text-xs">Cancel</button>
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
              className="flex-1 w-full p-4 bg-port-bg text-gray-200 text-sm resize-none focus:outline-none font-sans"
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
              className="flex items-center gap-2 px-4 py-3 border-t border-port-border bg-port-card/30"
            >
              <Plus size={14} className="text-gray-500" />
              <input
                type="text"
                value={quickAppend}
                onChange={(e) => setQuickAppend(e.target.value)}
                placeholder="Quick append — adds a new paragraph to this day's log…"
                className="flex-1 bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white placeholder-gray-500"
              />
              <button
                type="submit"
                disabled={appending || !quickAppend.trim()}
                className="px-3 py-1.5 rounded bg-port-accent text-white text-sm disabled:opacity-50"
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
