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

  const dirty = content !== (entry?.content || '');

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
    const onAppend = (payload) => {
      const appended = payload?.entry;
      if (!appended) return;
      setHistory((prev) => upsertHistory(prev, appended));
      if (appended.date === date) {
        setEntry(appended);
        setContent(appended.content || '');
      }
    };
    const onDictation = (payload) => {
      const nextEnabled = !!payload?.enabled;
      setDictation((prev) => {
        // Only toast on a real false→true transition — the server echoes
        // dictation state after every set (including our own toggleDictation
        // click, which already toasted locally), and without this guard we'd
        // stack "Dictation on" twice per click.
        if (!prev && nextEnabled) toast('Dictation on — speak your log.', { icon: '🎙️' });
        return prev === nextEnabled ? prev : nextEnabled;
      });
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
  const readBack = () => {
    const body = content.trim();
    if (!body) {
      toast('Daily log is empty.', { icon: '📖' });
      return;
    }
    sendText(`Read this back to me verbatim, exactly as written, with no commentary:\n\n${body}`);
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
  const segmentCount = entry?.segments?.length || 0;

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
                      {h.segments?.length || 0} segment{h.segments?.length === 1 ? '' : 's'}
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
