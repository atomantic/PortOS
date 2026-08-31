import { useEffect, useMemo, useState } from 'react';
import { Save, Loader2, MonitorPlay, RefreshCw, CheckCircle2, AlertCircle, ShieldQuestion, Search, ExternalLink, Download, X } from 'lucide-react';
import toast from '../../ui/Toast';
import FormField from '../../ui/FormField';
import BrailleSpinner from '../../BrailleSpinner';
import { formatDateTime } from '../../../utils/formatters';
import { useSyncSourceSettings } from '../../../hooks/useSyncSourceSettings';
import { useVideoDownload } from '../../../hooks';
import {
  getYoutubeStatus,
  getYoutubeSetupCheck,
  syncYoutube,
  getYoutubePlaylists,
  syncYoutubePlaylists,
} from '../../../services/api';

// Brain → YouTube (#2153). Opt-in, machine-local ingestion of YouTube watch
// history into the activity timeline. OFF by default — the YouTube watch-history
// API is gone, so this scrapes the signed-in history page in the managed browser.
// Requires being logged into YouTube there; the Takeout backfill on the Timeline
// page is the reliable historical path.
export function YoutubeTab() {
  const {
    loading, enabled, setEnabled, intervalMinutes, setIntervalMinutes, saving,
    status, setStatus, dirty, save,
  } = useSyncSourceSettings({ domain: 'youtube', defaultInterval: 480, getStatus: getYoutubeStatus });
  const [syncing, setSyncing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [setup, setSetup] = useState(null);
  const [playlists, setPlaylists] = useState(null);
  const [playlistsLoading, setPlaylistsLoading] = useState(true);
  const [playlistsSyncing, setPlaylistsSyncing] = useState(false);
  const [playlistQuery, setPlaylistQuery] = useState('');
  const [requestedVideoId, setRequestedVideoId] = useState(null);
  const { active: downloading, percent, stage, context: downloadingVideoId, start: startDownload, cancel: cancelDownload } = useVideoDownload();

  const loadPlaylists = () => {
    setPlaylistsLoading(true);
    return getYoutubePlaylists({ silent: true })
      .then((result) => setPlaylists(result?.snapshot || null))
      .catch(() => null)
      .finally(() => setPlaylistsLoading(false));
  };

  useEffect(() => { loadPlaylists(); }, []);
  useEffect(() => {
    if (!downloading) setRequestedVideoId(null);
  }, [downloading]);

  const handleSave = async () => {
    if (!await save()) return;
    toast.success('Saved — scheduler applies on next server restart');
  };

  const handleCheckSetup = async () => {
    setChecking(true);
    const result = await getYoutubeSetupCheck({ silent: true }).catch(() => null);
    setChecking(false);
    setSetup(result);
    if (result?.ok) toast.success('Signed into YouTube in the managed browser');
    else if (result) toast.error(result.error || 'YouTube not ready');
    else toast.error('Setup check failed');
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    const result = await syncYoutube({ silent: true }).catch(() => ({ ok: false, error: 'Sync failed' }));
    setSyncing(false);
    if (result?.ok) {
      toast.success(`Scraped ${result.scanned} entr${result.scanned === 1 ? 'y' : 'ies'} — ${result.recorded} new watch(es)`);
      setStatus((prev) => ({ ...(prev || {}), state: { ...(prev?.state || {}), lastResult: result, lastRunAt: new Date().toISOString() } }));
    } else {
      toast.error(result?.needsAuth ? 'Log into YouTube in the managed browser first' : (result?.error || 'Sync failed'));
    }
  };

  const handleSyncPlaylists = async () => {
    setPlaylistsSyncing(true);
    const result = await syncYoutubePlaylists({ silent: true }).catch(() => ({ ok: false, error: 'Playlist sync failed' }));
    setPlaylistsSyncing(false);
    if (!result?.ok && result?.error) {
      toast.error(result.error);
    } else if (result?.playlistCount !== undefined) {
      await loadPlaylists();
      if (result.ok) toast.success(`Synced ${result.playlistCount} playlist(s) and ${result.videoCount} video(s)`);
      else toast.error(`Playlist sync completed with ${result.failed || 0} warning(s)`);
    } else {
      toast.error(result?.needsAuth ? 'Log into YouTube in the managed browser first' : (result?.error || 'Playlist sync failed'));
    }
  };

  const handleDownload = (video) => {
    if (downloading) return;
    setRequestedVideoId(video.id);
    startDownload(video.url, video.id);
  };

  const lastResult = status?.state?.lastResult;
  const storedPlaylists = Array.isArray(playlists?.playlists) ? playlists.playlists : [];
  const filteredPlaylists = useMemo(() => {
    const query = playlistQuery.trim().toLowerCase();
    if (!query) return storedPlaylists;
    return storedPlaylists.filter((playlist) => String(playlist.name || '').toLowerCase().includes(query)
      || playlist.videos?.some((video) => String(video.title || '').toLowerCase().includes(query)
        || String(video.channel || '').toLowerCase().includes(query)));
  }, [playlistQuery, storedPlaylists]);
  const playlistVideoCount = storedPlaylists.reduce((total, playlist) => total + (playlist.videos?.length || 0), 0);

  if (loading) return <BrailleSpinner />;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <MonitorPlay size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">YouTube watch history</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Scrapes your{' '}
          <a href="https://www.youtube.com/feed/history" target="_blank" rel="noreferrer" className="text-port-accent hover:underline">
            YouTube history
          </a>{' '}
          in the managed browser and feeds the activity timeline (taste signal for the digital twin). There is no
          watch-history API, so this reads the signed-in page — log into YouTube in the managed browser first.
          Machine-local — nothing federates to peers. For full historical data, use the Google Takeout backfill on
          the Timeline page.
        </p>

        {/* Step 1 — sign in / setup check */}
        <div className="space-y-3 border-b border-port-border pb-5 mb-5">
          <h4 className="text-sm font-semibold text-gray-200">1. Sign into YouTube in the managed browser</h4>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCheckSetup}
              disabled={checking}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {checking ? <Loader2 size={14} className="animate-spin" /> : <ShieldQuestion size={14} />}
              Check setup
            </button>
            {setup && (
              setup.ok ? (
                <span className="inline-flex items-center gap-1.5 text-port-success text-sm"><CheckCircle2 size={14} /> Signed in &amp; ready</span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-port-warning text-sm"><AlertCircle size={14} /> {setup.error || 'Not ready'}</span>
              )
            )}
          </div>
          {setup && !setup.ok && setup.remediation && (
            <p className="text-xs text-gray-500">{setup.remediation}</p>
          )}
        </div>

        {/* Step 2 — schedule */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-200">2. Scheduled scrape</h4>
          <label htmlFor="youtube-enabled" className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              id="youtube-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 accent-port-accent"
            />
            Enable scheduled YouTube scrape
          </label>

          <FormField
            label="Scrape interval (minutes)"
            labelClassName="block text-xs uppercase tracking-wider text-gray-500 mb-1"
          >
            <input
              id="youtube-interval"
              type="number"
              min={1}
              max={1440}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(e.target.value)}
              className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              The history page only shows day-bucketed entries — a few times a day (e.g. 480 min) is plenty. Be a polite scraper.
            </p>
          </FormField>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleSyncNow}
              disabled={syncing}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Scrape now
            </button>
          </div>
        </div>
      </div>

      {lastResult && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-white mb-2">Last scrape</h3>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div><dt className="text-gray-500 text-xs uppercase">Watches recorded</dt><dd className="text-gray-200">{lastResult?.recorded ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Entries scanned</dt><dd className="text-gray-200">{lastResult?.scanned ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Status</dt><dd className="text-gray-200">{lastResult?.ok ? 'ok' : (lastResult?.error || lastResult?.status || 'error')}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Last run</dt><dd className="text-gray-200">{formatDateTime(status?.state?.lastRunAt, '—')}</dd></div>
          </dl>
        </div>
      )}

      <section className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            <MonitorPlay size={16} className="text-port-accent" />
            <h3 className="text-lg font-semibold text-white">Playlist video library</h3>
          </div>
          <button
            type="button"
            onClick={handleSyncPlaylists}
            disabled={playlistsSyncing}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {playlistsSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Sync playlists
          </button>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Browse the videos you have organized in YouTube playlists. Download is always an explicit action and uses
          the shared Video Downloader, so completed videos also land in the PortOS media library.
        </p>

        {downloading && (
          <div className="mb-4 rounded border border-port-accent/30 bg-port-accent/10 p-3 text-sm text-port-accent">
            <div className="flex items-center gap-2">
              <Loader2 size={15} className="animate-spin shrink-0" />
              <span className="truncate">{stage ? `${stage}…` : 'Downloading video…'} {percent > 0 ? `${percent}%` : ''}</span>
              <button type="button" onClick={cancelDownload} className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-gray-300 hover:text-white"><X size={13} /> Cancel</button>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded bg-port-border"><div className="h-full bg-port-accent transition-all" style={{ width: `${percent}%` }} /></div>
          </div>
        )}

        {playlistsLoading ? <BrailleSpinner /> : storedPlaylists.length > 0 ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-500">
              <span>{storedPlaylists.length} playlist(s)</span>
              <span>{playlistVideoCount} video reference(s)</span>
              {playlists.syncedAt && <span>Last synced {formatDateTime(playlists.syncedAt)}</span>}
              {playlists.warnings?.length > 0 && <span className="text-port-warning">{playlists.warnings.length} incomplete</span>}
            </div>
            <label htmlFor="youtube-playlist-search" className="sr-only">Search playlists and videos</label>
            <div className="relative mb-4 max-w-md">
              <Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-gray-500" />
              <input
                id="youtube-playlist-search"
                type="search"
                value={playlistQuery}
                onChange={(event) => setPlaylistQuery(event.target.value)}
                placeholder="Search playlists, videos, or channels"
                className="w-full rounded border border-port-border bg-port-bg py-2 pl-9 pr-3 text-sm text-white placeholder:text-gray-500"
              />
            </div>
            {filteredPlaylists.length > 0 ? (
              <div className="grid gap-3 xl:grid-cols-2">
                {filteredPlaylists.map((playlist) => (
                  <YoutubePlaylistCard
                    key={playlist.id}
                    playlist={playlist}
                    downloading={downloading}
                    downloadingVideoId={downloadingVideoId || requestedVideoId}
                    onDownload={handleDownload}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded border border-dashed border-port-border p-6 text-center text-sm text-gray-500">No playlists or videos match that search.</p>
            )}
            {playlists.warnings?.length > 0 && <p className="mt-4 text-xs text-port-warning">Some playlist pages could not be refreshed; existing references were retained where available.</p>}
          </>
        ) : (
          <div className="rounded border border-dashed border-port-border p-6 text-center text-sm text-gray-500">
            Sync playlists to build your local YouTube video reference library.
          </div>
        )}
      </section>
    </div>
  );
}

function YoutubePlaylistCard({ playlist, downloading, downloadingVideoId, onDownload }) {
  const videos = playlist.videos || [];
  return (
    <section className="min-w-0 rounded border border-port-border bg-port-bg/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate font-semibold text-gray-100">{playlist.name}</h4>
          <span className="text-xs text-gray-500">{playlist.videoCount} video(s)</span>
        </div>
        <a href={playlist.url} target="_blank" rel="noreferrer" className="shrink-0 text-gray-500 hover:text-port-accent" aria-label={`Open ${playlist.name} on YouTube`}>
          <ExternalLink size={15} />
        </a>
      </div>
      {videos.length > 0 && (
        <div className="mt-3 divide-y divide-port-border/60 border-t border-port-border/60">
          {videos.map((video) => (
            <div key={video.id} className="flex min-w-0 items-center gap-2 py-2">
              {video.thumbnail && <img src={video.thumbnail} alt="" className="h-12 w-20 shrink-0 rounded object-cover" />}
              <div className="min-w-0 flex-1">
                <a href={video.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-gray-200 hover:text-port-accent hover:underline">{video.title}</a>
                <div className="truncate text-[11px] text-gray-500">{video.channel || 'Unknown channel'}{video.duration ? ` · ${video.duration}` : ''}</div>
              </div>
              <button
                type="button"
                onClick={() => onDownload(video)}
                disabled={downloading}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-port-border px-2 py-1.5 text-[11px] text-gray-300 hover:border-port-accent hover:text-port-accent disabled:cursor-not-allowed disabled:opacity-40"
                title={downloadingVideoId === video.id ? 'Downloading this video' : 'Download this video'}
              >
                {downloadingVideoId === video.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                <span className="hidden sm:inline">{downloadingVideoId === video.id ? 'Downloading' : 'Download'}</span>
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 text-[10px] uppercase tracking-wide text-gray-600">YouTube reference</div>
    </section>
  );
}

export default YoutubeTab;
