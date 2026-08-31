import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Save, Loader2, Music, Link2, LogOut, RefreshCw, CheckCircle2, AlertCircle, ExternalLink, Search } from 'lucide-react';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import { formatDateTime } from '../../../utils/formatters';
import { useSyncSourceSettings } from '../../../hooks/useSyncSourceSettings';
import {
  getSpotifyStatus,
  getSpotifyAuthUrl,
  saveSpotifyCredentials,
  clearSpotifyAuth,
  syncSpotify,
  getSpotifyPlaylists,
  syncSpotifyPlaylists,
} from '../../../services/api';

// Brain → Spotify (#2152). Opt-in, machine-local ingestion of Spotify
// listening history (recently-played) into the activity timeline. OFF by
// default — requires a user-created Spotify developer app + OAuth connection.
export function SpotifyTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    loading, enabled, setEnabled, intervalMinutes, setIntervalMinutes, saving,
    status, setStatus, dirty, save,
  } = useSyncSourceSettings({ domain: 'spotify', defaultInterval: 25, getStatus: getSpotifyStatus });

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [savingCreds, setSavingCreds] = useState(false);

  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [playlists, setPlaylists] = useState(null);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlistsSyncing, setPlaylistsSyncing] = useState(false);
  const [playlistQuery, setPlaylistQuery] = useState('');
  const auth = status?.auth;

  const loadStatus = () => getSpotifyStatus({ silent: true }).catch(() => null).then((st) => { if (st) setStatus(st); return st; });

  const loadPlaylists = () => {
    setPlaylistsLoading(true);
    return getSpotifyPlaylists({ silent: true })
      .then((result) => setPlaylists(result?.snapshot || null))
      .catch(() => null)
      .finally(() => setPlaylistsLoading(false));
  };

  useEffect(() => {
    if (!loading && auth?.hasTokens) loadPlaylists();
  }, [loading, auth?.hasTokens]);

  // Surface the OAuth callback outcome (the browser redirect lands back here).
  useEffect(() => {
    if (searchParams.get('oauthConnected')) {
      toast.success('Spotify connected');
      loadStatus();
      searchParams.delete('oauthConnected');
      setSearchParams(searchParams, { replace: true });
    } else if (searchParams.get('oauthError')) {
      toast.error(`Spotify connect failed: ${searchParams.get('oauthError')}`);
      searchParams.delete('oauthError');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleSave = async () => {
    if (!await save()) return;
    toast.success('Saved — scheduler applies on next server restart');
  };

  const handleSaveCreds = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error('Enter both client ID and client secret');
      return;
    }
    setSavingCreds(true);
    const result = await saveSpotifyCredentials(
      { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
      { silent: true },
    ).catch(() => null);
    setSavingCreds(false);
    if (!result) { toast.error('Failed to save credentials'); return; }
    toast.success('Spotify credentials saved');
    setClientSecret('');
    loadStatus();
  };

  const handleConnect = async () => {
    setConnecting(true);
    const result = await getSpotifyAuthUrl({ silent: true }).catch(() => null);
    setConnecting(false);
    if (result?.url) {
      window.location.href = result.url;
    } else {
      toast.error('Save your Spotify credentials first');
    }
  };

  const handleDisconnect = async () => {
    const result = await clearSpotifyAuth({ silent: true }).catch(() => null);
    if (result?.cleared) {
      toast.success('Spotify disconnected');
      loadStatus();
    } else {
      toast.error('Failed to disconnect');
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    const result = await syncSpotify({ silent: true }).catch(() => ({ ok: false, error: 'Sync failed' }));
    setSyncing(false);
    if (result?.ok) {
      toast.success(`Synced: ${result.recorded} listen(s)${result.hasMore ? ' — more history remains, run again' : ''}`);
      setStatus((prev) => ({ ...(prev || {}), state: { ...(prev?.state || {}), cursorAfter: result.cursorAfter, lastResult: result, lastRunAt: new Date().toISOString() } }));
    } else {
      toast.error(result?.needsAuth ? 'Connect Spotify first' : (result?.error || 'Sync failed'));
    }
  };

  const handleSyncPlaylists = async () => {
    setPlaylistsSyncing(true);
    const result = await syncSpotifyPlaylists({ silent: true }).catch(() => ({ ok: false, error: 'Playlist sync failed' }));
    setPlaylistsSyncing(false);
    if (!result?.ok && result?.error) {
      toast.error(result.error);
    } else if (result?.playlistCount !== undefined) {
      await loadPlaylists();
      if (result.ok) toast.success(`Synced ${result.playlistCount} playlist(s) and ${result.trackCount} track(s)`);
      else toast.error(`Playlist sync completed with ${result.failed || 0} warning(s)`);
    } else {
      toast.error(result?.needsAuth ? 'Connect Spotify first' : (result?.error || 'Playlist sync failed'));
    }
  };

  const lastResult = status?.state?.lastResult;
  const hasPlaylistScope = String(auth?.scope || '').split(/\s+/).includes('playlist-read-private');
  const storedPlaylists = Array.isArray(playlists?.playlists) ? playlists.playlists : [];
  const filteredPlaylists = useMemo(() => {
    const query = playlistQuery.trim().toLowerCase();
    if (!query) return storedPlaylists;
    return storedPlaylists.filter((playlist) => String(playlist.name || '').toLowerCase().includes(query)
      || playlist.tracks?.some((track) => String(track.name || '').toLowerCase().includes(query)
        || track.artists?.some((artist) => String(artist.name || '').toLowerCase().includes(query))));
  }, [playlistQuery, storedPlaylists]);
  const playlistTrackCount = storedPlaylists.reduce((total, playlist) => total + (playlist.tracks?.length || 0), 0);

  if (loading) return <BrailleSpinner />;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Music size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Spotify listening history</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Polls your Spotify recently-played tracks and feeds the activity timeline (taste signal for the digital
          twin). Machine-local — nothing federates to peers. Requires a free{' '}
          <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer" className="text-port-accent hover:underline">
            Spotify developer app
          </a>{' '}
          — create one, add the redirect URI below, then paste its client ID and secret.
        </p>

        {/* Step 1 — developer app credentials */}
        <div className="space-y-3 border-b border-port-border pb-5 mb-5">
          <h4 className="text-sm font-semibold text-gray-200">1. Developer app credentials</h4>
          {auth?.redirectUri && (
            <p className="text-xs text-gray-500">
              Add this exact redirect URI in your Spotify app settings:{' '}
              <code className="text-gray-300 break-all">{auth.redirectUri}</code>
            </p>
          )}
          <div>
            <label htmlFor="spotify-client-id" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Client ID
            </label>
            <input
              id="spotify-client-id"
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={auth?.hasCredentials ? '•••••••• (saved — re-enter to change)' : 'Spotify app client ID'}
              className="w-full max-w-md px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
          </div>
          <div>
            <label htmlFor="spotify-client-secret" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Client secret
            </label>
            <input
              id="spotify-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={auth?.hasCredentials ? '•••••••• (saved — re-enter to change)' : 'Spotify app client secret'}
              className="w-full max-w-md px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
          </div>
          <button
            type="button"
            onClick={handleSaveCreds}
            disabled={savingCreds}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40"
          >
            {savingCreds ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save credentials
          </button>
        </div>

        {/* Step 2 — connect via OAuth */}
        <div className="space-y-3 border-b border-port-border pb-5 mb-5">
          <h4 className="text-sm font-semibold text-gray-200">2. Connect your Spotify account</h4>
          <div className="flex items-center gap-2 text-sm">
            {auth?.hasTokens ? (
              <span className="inline-flex items-center gap-1.5 text-port-success"><CheckCircle2 size={14} /> Connected</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-gray-400"><AlertCircle size={14} /> Not connected</span>
            )}
            {auth?.expiresAt && <span className="text-gray-500 text-xs">token expires {formatDateTime(auth.expiresAt)}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting || !auth?.hasCredentials}
              title={!auth?.hasCredentials ? 'Save credentials first' : undefined}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
              {auth?.hasTokens ? 'Reconnect' : 'Connect Spotify'}
            </button>
            {auth?.hasTokens && (
              <button
                type="button"
                onClick={handleDisconnect}
                className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-error text-gray-200 rounded-lg text-sm transition-colors"
              >
                <LogOut size={14} /> Disconnect
              </button>
            )}
          </div>
        </div>

        {/* Step 3 — schedule */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-200">3. Scheduled sync</h4>
          <label htmlFor="spotify-enabled" className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              id="spotify-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 accent-port-accent"
            />
            Enable scheduled Spotify sync
          </label>

          <div>
            <label htmlFor="spotify-interval" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Sync interval (minutes)
            </label>
            <input
              id="spotify-interval"
              type="number"
              min={1}
              max={1440}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(e.target.value)}
              className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              Spotify only exposes the last 50 plays — keep this under ~25 min so no listens are missed.
            </p>
          </div>

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
              disabled={syncing || !auth?.hasTokens}
              title={!auth?.hasTokens ? 'Connect Spotify first' : undefined}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Sync now
            </button>
          </div>
        </div>
      </div>

      {(lastResult || status?.state?.cursorAfter > 0) && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-white mb-2">Last sync</h3>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div><dt className="text-gray-500 text-xs uppercase">Listens recorded</dt><dd className="text-gray-200">{lastResult?.recorded ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Scanned</dt><dd className="text-gray-200">{lastResult?.scanned ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">More remaining</dt><dd className="text-gray-200">{lastResult?.hasMore ? 'yes' : 'no'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Last run</dt><dd className="text-gray-200">{formatDateTime(status?.state?.lastRunAt, '—')}</dd></div>
          </dl>
        </div>
      )}

      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            <Music size={16} className="text-port-accent" />
            <h3 className="text-lg font-semibold text-white">Playlist taste library</h3>
          </div>
          <button
            type="button"
            onClick={handleSyncPlaylists}
            disabled={playlistsSyncing || !auth?.hasTokens || !hasPlaylistScope}
            title={!auth?.hasTokens ? 'Connect Spotify first' : (!hasPlaylistScope ? 'Reconnect Spotify to grant playlist access' : undefined)}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {playlistsSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Sync playlists
          </button>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          A local reference shelf for the music you keep and revisit. PortOS stores playlist and track metadata here
          so your musical context stays alongside your Brain consumption history. It never sends this library to peers.
        </p>

        {auth?.hasTokens && !hasPlaylistScope && (
          <div className="mb-4 flex items-start gap-2 rounded border border-port-warning/30 bg-port-warning/10 p-3 text-sm text-port-warning">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>Reconnect Spotify above to grant playlist access. Your existing listening-history connection remains usable.</span>
          </div>
        )}

        {playlistsLoading ? <BrailleSpinner /> : storedPlaylists.length > 0 ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-500">
              <span>{storedPlaylists.length} playlist(s)</span>
              <span>{playlistTrackCount} track reference(s)</span>
              {playlists.syncedAt && <span>Last synced {formatDateTime(playlists.syncedAt)}</span>}
              {playlists.warnings?.length > 0 && <span className="text-port-warning">{playlists.warnings.length} incomplete</span>}
            </div>
            <label htmlFor="spotify-playlist-search" className="sr-only">Search playlists and tracks</label>
            <div className="relative mb-4 max-w-md">
              <Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-gray-500" />
              <input
                id="spotify-playlist-search"
                type="search"
                value={playlistQuery}
                onChange={(event) => setPlaylistQuery(event.target.value)}
                placeholder="Search playlists or tracks"
                className="w-full rounded border border-port-border bg-port-bg py-2 pl-9 pr-3 text-sm text-white placeholder:text-gray-500"
              />
            </div>
            {filteredPlaylists.length > 0 ? (
              <div className="grid gap-3 xl:grid-cols-2">
                {filteredPlaylists.map((playlist) => (
                  <PlaylistCard key={playlist.id} playlist={playlist} query={playlistQuery} />
                ))}
              </div>
            ) : (
              <p className="rounded border border-dashed border-port-border p-6 text-center text-sm text-gray-500">No playlists or tracks match that search.</p>
            )}
            {playlists.warnings?.length > 0 && (
              <p className="mt-4 text-xs text-port-warning">Some playlists could not be refreshed; retained references are marked by the last successful sync.</p>
            )}
          </>
        ) : (
          <div className="rounded border border-dashed border-port-border p-6 text-center text-sm text-gray-500">
            {auth?.hasTokens && hasPlaylistScope
              ? 'Sync playlists to build your local music reference shelf.'
              : 'Connect Spotify and grant playlist access to build your local music reference shelf.'}
          </div>
        )}
      </div>
    </div>
  );
}

function PlaylistCard({ playlist, query }) {
  const matchingTracks = playlist.tracks || [];
  const visibleTracks = query.trim() ? matchingTracks : matchingTracks.slice(0, 8);
  const remaining = Math.max(0, matchingTracks.length - visibleTracks.length);
  const image = playlist.images?.[0];
  return (
    <section className="min-w-0 rounded border border-port-border bg-port-bg/40 p-3">
      <div className="flex gap-3">
        {image && <img src={image.url} alt="" className="h-16 w-16 shrink-0 rounded object-contain" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h4 className="truncate font-semibold text-gray-100">{playlist.name}</h4>
            <a href={playlist.spotifyUrl} target="_blank" rel="noreferrer" className="shrink-0 text-gray-500 hover:text-port-accent" aria-label={`Open ${playlist.name} in Spotify`}>
              <ExternalLink size={15} />
            </a>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-gray-500">
            <span>{playlist.trackCount} track(s)</span>
            {playlist.public === false && <span>Private</span>}
            {playlist.collaborative && <span>Collaborative</span>}
          </div>
          {playlist.description && <p className="mt-1 line-clamp-2 text-xs text-gray-400">{playlist.description}</p>}
        </div>
      </div>
      {visibleTracks.length > 0 && (
        <div className="mt-3 divide-y divide-port-border/60 border-t border-port-border/60">
          {visibleTracks.map((track, index) => (
            <div key={`${track.id}-${track.addedAt || index}`} className="flex min-w-0 items-center gap-2 py-2 text-xs">
              <span className="w-5 shrink-0 text-right text-gray-600">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <a href={track.spotifyUrl} target="_blank" rel="noreferrer" className="block truncate text-gray-200 hover:text-port-accent hover:underline">{track.name}</a>
                <div className="truncate text-gray-500">{track.artists?.map((artist) => artist.name).join(', ') || 'Unknown artist'}{track.album ? ` · ${track.album}` : ''}</div>
              </div>
            </div>
          ))}
          {remaining > 0 && <div className="pt-2 text-center text-xs text-gray-500">+ {remaining} more track(s)</div>}
        </div>
      )}
      <div className="mt-3 text-[10px] uppercase tracking-wide text-gray-600">Spotify reference</div>
    </section>
  );
}

export default SpotifyTab;
