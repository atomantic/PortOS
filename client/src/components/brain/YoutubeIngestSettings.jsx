import { useState, useEffect, useCallback } from 'react';
import { Film, Save, Trash2 } from 'lucide-react';
import * as api from '../../services/api';
import { INGEST_OPTIONS } from '../../lib/youtubeUrl';
import { formatDurationMs, timeAgo } from '../../utils/formatters';
import BrailleSpinner from '../BrailleSpinner';
import InfiniteScrollFooter from '../ui/InfiniteScrollFooter';
import { usePagedCollection } from '../../hooks/usePagedCollection';
import toast from '../ui/Toast';

const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const INGESTS_PAGE_SIZE = 50;

/**
 * Settings for the YouTube → Brain ingest, plus the list of what has been
 * ingested so far: which Obsidian vault/folder transcripts are mirrored into,
 * what the Quick Capture panel defaults to, and a way to forget an ingest.
 *
 * The vault select's empty option is meaningful, not a placeholder: an unset
 * vault means "inherit the Daily Log's vault", which is what makes the feature
 * work with zero configuration for anyone who already pointed the journal at
 * Obsidian.
 */
export default function YoutubeIngestSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [vaults, setVaults] = useState([]);
  const [settings, setSettings] = useState(null);
  // Two-click arm rather than a confirm dialog, per the client UI conventions.
  const [armedDelete, setArmedDelete] = useState(null);

  useEffect(() => {
    Promise.all([
      api.getYoutubeIngestSettings({ silent: true }).catch(() => null),
      api.getNotesVaults().catch(() => ({ vaults: [] })),
    ]).then(([loaded, vaultData]) => {
      setSettings(loaded);
      setVaults(vaultData?.vaults || []);
      setLoading(false);
    });
  }, []);

  // Loads 50 records at a time; `usePagedCollection` dedupes by `id`, so each
  // record is given one from its `videoId` (the ingest index's own key). A
  // failed fetch must reject rather than resolve empty, or `usePagedCollection`
  // reads it as "no more records" and InfiniteScrollFooter's retry never shows.
  const fetchIngestsPage = useCallback(async ({ cursor, signal }) => {
    const res = await api.getYoutubeIngests({ limit: INGESTS_PAGE_SIZE, cursor, silent: true, signal });
    return {
      items: (res.ingests || []).map((record) => ({ ...record, id: record.videoId })),
      nextCursor: res.nextCursor ?? null,
    };
  }, []);
  const ingestsPage = usePagedCollection(fetchIngestsPage);
  const ingests = ingestsPage.items;

  const handleForget = async (videoId) => {
    if (armedDelete !== videoId) {
      setArmedDelete(videoId);
      return;
    }
    setArmedDelete(null);
    const ok = await api.deleteYoutubeIngest(videoId, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to remove the ingest');
      return null;
    });
    if (!ok) return;
    ingestsPage.setItems((prev) => prev.filter((i) => i.videoId !== videoId));
    toast.success('Ingest removed — the link, video and timeline entry were kept');
  };

  const patch = (updates) => setSettings((prev) => ({ ...prev, ...updates }));

  const handleSave = async () => {
    setSaving(true);
    const saved = await api.updateYoutubeIngestSettings({
      obsidianVaultId: settings.obsidianVaultId || null,
      obsidianFolder: settings.obsidianFolder || '',
      autoSync: !!settings.autoSync,
      // Same table Quick Capture's checkboxes come from, so a new artifact
      // becomes settable here without a second edit.
      ...Object.fromEntries(INGEST_OPTIONS.map((o) => [o.settingKey, !!settings[o.settingKey]])),
      taskPriority: settings.taskPriority,
    }).catch((err) => {
      toast.error(err.message || 'Failed to save YouTube ingest settings');
      return null;
    });
    if (saved) {
      setSettings(saved);
      toast.success('YouTube ingest settings saved');
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <section className="p-4 bg-port-card border border-port-border rounded-lg">
        <BrailleSpinner />
      </section>
    );
  }
  if (!settings) return null;

  return (
    <section className="p-4 bg-port-card border border-port-border rounded-lg space-y-4">
      <div className="flex items-center gap-2">
        <Film className="w-5 h-5 text-red-400" />
        <h3 className="text-md font-semibold text-white">YouTube Ingest</h3>
      </div>
      <p className="text-xs text-gray-500">
        Paste a YouTube link into Quick Capture to pull in its transcript, video, or audio.
        Transcripts are mirrored into your Obsidian vault as a note.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="ytVault" className="block text-sm font-medium text-gray-300 mb-2">
            Obsidian Vault
          </label>
          <select
            id="ytVault"
            value={settings.obsidianVaultId || ''}
            onChange={(e) => patch({ obsidianVaultId: e.target.value || null })}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent"
          >
            <option value="">Same as Daily Log</option>
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            {vaults.length === 0
              ? 'No vaults configured yet — add one under Brain → Notes.'
              : 'Leave as "Same as Daily Log" to reuse the journal\'s vault.'}
          </p>
        </div>

        <div>
          <label htmlFor="ytFolder" className="block text-sm font-medium text-gray-300 mb-2">
            Vault Folder
          </label>
          <input
            id="ytFolder"
            type="text"
            value={settings.obsidianFolder ?? ''}
            onChange={(e) => patch({ obsidianFolder: e.target.value })}
            placeholder="Consumed/YouTube"
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent"
          />
          <p className="mt-1 text-xs text-gray-500">Where transcript notes are written. Blank = vault root.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label htmlFor="ytAutoSync" className="flex items-center gap-2 text-sm text-gray-300">
          <input
            id="ytAutoSync"
            type="checkbox"
            checked={!!settings.autoSync}
            onChange={(e) => patch({ autoSync: e.target.checked })}
            className="accent-port-accent"
          />
          Mirror transcripts to Obsidian
        </label>

        <div className="flex items-center gap-2">
          <label htmlFor="ytPriority" className="text-sm text-gray-300">Review task priority</label>
          <select
            id="ytPriority"
            value={settings.taskPriority || 'MEDIUM'}
            onChange={(e) => patch({ taskPriority: e.target.value })}
            className="px-2 py-1 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-hidden focus:ring-2 focus:ring-port-accent"
          >
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      <div>
        <span className="block text-sm font-medium text-gray-300 mb-2">Capture by default</span>
        <div className="flex flex-wrap gap-4">
          {INGEST_OPTIONS.map(({ settingKey, label, hint }) => (
            <label key={settingKey} htmlFor={`yt-${settingKey}`} title={hint} className="flex items-center gap-2 text-sm text-gray-300">
              <input
                id={`yt-${settingKey}`}
                type="checkbox"
                checked={!!settings[settingKey]}
                onChange={(e) => patch({ [settingKey]: e.target.checked })}
                className="accent-port-accent"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50"
      >
        <Save size={14} />
        {saving ? 'Saving…' : 'Save YouTube Settings'}
      </button>

      {(ingests.length > 0 || ingestsPage.loading || Boolean(ingestsPage.error)) && (
        <div className="pt-4 border-t border-port-border">
          <h4 className="text-sm font-medium text-gray-400 mb-2">
            Ingested ({ingests.length}{ingestsPage.hasMore ? '+' : ''})
          </h4>
          <div className="max-h-64 overflow-y-auto">
            <ul className="space-y-1">
              {ingests.map((ingest) => (
                <li key={ingest.videoId} className="flex items-center gap-2 py-1.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <a
                      href={ingest.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-gray-200 hover:text-port-accent transition-colors"
                    >
                      {ingest.title || ingest.videoId}
                    </a>
                    <p className="text-xs text-gray-500 truncate">
                      {[
                        ingest.channel,
                        ingest.durationSec ? formatDurationMs(ingest.durationSec * 1000) : null,
                        ingest.transcript ? `${Math.round(ingest.transcript.chars / 1000)}k transcript` : 'no transcript',
                        ingest.audio ? 'audio' : null,
                        ingest.video ? 'video' : null,
                        ingest.ingestedAt ? timeAgo(ingest.ingestedAt) : null,
                      ].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleForget(ingest.videoId)}
                    onBlur={() => setArmedDelete((v) => (v === ingest.videoId ? null : v))}
                    aria-label={`Forget ingest: ${ingest.title || ingest.videoId}`}
                    title="Removes the stored transcript, audio and Obsidian note. The link, downloaded video and timeline entry are kept."
                    className={`flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg transition-colors ${armedDelete === ingest.videoId
                      ? 'text-red-300 bg-red-500/20'
                      : 'text-gray-500 hover:text-red-400'}`}
                  >
                    {armedDelete === ingest.videoId ? <span className="text-xs px-1">Sure?</span> : <Trash2 size={14} />}
                  </button>
                </li>
              ))}
            </ul>
            <InfiniteScrollFooter
              hasMore={ingestsPage.hasMore}
              loading={ingestsPage.loading}
              error={ingestsPage.error}
              onLoadMore={ingestsPage.loadMore}
            />
          </div>
        </div>
      )}
    </section>
  );
}
