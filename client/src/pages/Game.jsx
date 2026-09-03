import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Boxes, Gamepad2, Images, MessageSquare, Plus } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import AppContextPicker from '../components/AppContextPicker.jsx';
import GameBindings from '../components/games/GameBindings.jsx';
import GameCompilePanel from '../components/games/GameCompilePanel.jsx';
import GameFeedback from '../components/games/GameFeedback.jsx';
import TabPills from '../components/ui/TabPills.jsx';
import useDrawerTab from '../hooks/useDrawerTab.js';
import {
  bindGameArtwork,
  bindGameMusic,
  bindGameSprite,
  compileGameAssets,
  createGame,
  getApps,
  getGame,
  getGameIntegrity,
  listGames,
  listImageGallery,
  listSpriteRecords,
  listTracks,
  launchNativeApp,
  publishGameArtwork,
  publishGameMusic,
  requestGameFeedback,
  startApp,
  unbindGameArtwork,
  unbindGameMusic,
  unbindGameSprite,
  updateGameArtwork,
  updateGameMusic,
} from '../services/api.js';
import { timeAgo } from '../utils/formatters.js';

const silent = { silent: true };
const DETAIL_TABS = [
  { id: 'bundle', label: 'Bundle', icon: Boxes },
  {
    id: 'assets',
    label: 'Assets',
    icon: Images,
    count: (game) => game.spriteBindings.length
      + game.musicBindings.length
      + (game.artworkBindings?.length || 0),
  },
  { id: 'feedback', label: 'Feedback', icon: MessageSquare, count: (game) => game.feedbackHistory.length },
];
const DETAIL_TAB_IDS = DETAIL_TABS.map((tab) => tab.id);

export default function Game() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useDrawerTab('gameTab', 'bundle', DETAIL_TAB_IDS);
  const [games, setGames] = useState([]);
  const [apps, setApps] = useState([]);
  const [sprites, setSprites] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [gallery, setGallery] = useState([]);
  // Integrity is keyed by the game it describes, never stored bare. `/game/A` →
  // `/game/B` reuses the same route, so the component does NOT remount: unkeyed
  // state would render B's panel with A's verdict — enabling "Start game" for a
  // game with no verified bundle — and an in-flight fetch for A that resolves
  // after B's would overwrite B's result permanently, with nothing to clear it.
  const [integrityFor, setIntegrityFor] = useState(null);
  const [integrityFetching, setIntegrityFetching] = useState(false);
  const [compileError, setCompileError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [name, setName] = useState('');
  const [appId, setAppId] = useState('');
  // Music binding id whose publish hit a 409 PUBLISH_DEST_OCCUPIED — the row
  // shows an inline overwrite consent instead of a dead-end error toast.
  const [musicOverwrite, setMusicOverwrite] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await Promise.all([
      listGames(silent),
      getApps(silent),
      listSpriteRecords(silent),
      listTracks(silent),
      listImageGallery(silent),
    ]).catch(() => null);
    if (!result) {
      toast.error('Failed to load the Game studio');
    } else {
      const [gameRows, appRows, spriteRows, trackRows, galleryRows] = result;
      setGames(Array.isArray(gameRows) ? gameRows : []);
      setApps((Array.isArray(appRows) ? appRows : []).filter((app) => !app.archived));
      setSprites(Array.isArray(spriteRows) ? spriteRows : []);
      setTracks(Array.isArray(trackRows) ? trackRows : []);
      setGallery((Array.isArray(galleryRows) ? galleryRows : []).filter((image) => !image.hidden));
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const refreshIntegrity = useCallback(async () => {
    if (!id) {
      setIntegrityFor(null);
      return;
    }
    setIntegrityFetching(true);
    const data = await getGameIntegrity(id, silent).catch(() => null);
    setIntegrityFor({ gameId: id, data });
    setIntegrityFetching(false);
  }, [id]);

  useEffect(() => {
    refreshIntegrity();
  }, [refreshIntegrity]);

  // Only a result carrying THIS game's id counts. Anything else — another
  // game's verdict, or nothing fetched yet — reads as "still loading", which
  // keeps every gate closed rather than open on a stale `canLaunch`.
  //
  // `integrityFor && id &&` is load-bearing, not defensive padding: on the index
  // route `id` is undefined AND there is no result, so a bare
  // `integrityFor?.gameId === id` compares undefined to undefined, matches, and
  // dereferences null.
  const matchesGame = Boolean(integrityFor && id && integrityFor.gameId === id);
  const integrity = matchesGame ? integrityFor.data : null;
  const integrityLoading = integrityFetching || !matchesGame;

  const game = useMemo(() => games.find((entry) => entry.id === id) || null, [games, id]);
  const app = apps.find((entry) => entry.id === game?.appId);
  const replaceGame = (updated) => setGames((current) =>
    current.some((entry) => entry.id === updated.id)
      ? current.map((entry) => (entry.id === updated.id ? updated : entry))
      : [updated, ...current]);

  const create = async (event) => {
    event.preventDefault();
    if (!name.trim() || !appId) return;
    setBusy('create');
    const created = await createGame({ appId, name: name.trim() }, silent).catch(() => null);
    setBusy('');
    if (!created) { toast.error('Failed to create Game'); return; }
    replaceGame(created);
    navigate(`/game/${created.id}`);
  };

  const mutate = async (key, action, successMessage) => {
    setBusy(key);
    const updated = await action().catch(() => null);
    setBusy('');
    if (!updated) { toast.error('Game update failed'); return false; }
    replaceGame(updated);
    setCompileError('');
    await refreshIntegrity();
    if (successMessage) toast.success(successMessage);
    return true;
  };

  const compile = async () => {
    setBusy('compile');
    setCompileError('');
    let message = '';
    const result = await compileGameAssets(game.id, silent)
      .catch((error) => { message = error?.message || 'Bundle compilation failed'; return null; });
    const refreshed = result ? await getGame(game.id, silent).catch(() => null) : null;
    await refreshIntegrity();
    setBusy('');
    if (!result) {
      setCompileError(message || 'Bundle compilation failed');
      return;
    }
    const built = result.created
      ? `Built and verified bundle v${result.version}`
      : `Bundle v${result.version} is already verified`;
    // The build landed — say so. A failed re-read is a separate, lesser problem
    // (this view is out of date), not evidence the build failed; reporting it as
    // "Bundle compilation failed" would contradict the Verified badge that the
    // independent integrity refresh just set.
    toast.success(built);
    if (!refreshed) {
      setCompileError('The bundle was built, but this page could not reload it. Refresh to see the new version.');
      return;
    }
    replaceGame(refreshed);
  };

  const launch = async () => {
    if (!app || !integrity?.canLaunch) return;
    setBusy('launch');
    const result = await (app.nativeLaunch
      ? launchNativeApp(app.id, silent)
      : startApp(app.id, silent)).catch(() => null);
    setBusy('');
    if (!result?.success) {
      toast.error('Game launch failed');
      return;
    }
    toast.success(app.nativeLaunch?.label || 'Game started');
  };

  const feedback = async (payload) => {
    setBusy('feedback');
    const result = await requestGameFeedback(game.id, payload, silent).catch(() => null);
    setBusy('');
    if (!result?.game) { toast.error('AI feedback request failed'); return false; }
    replaceGame(result.game);
    toast.success('Feedback added');
    return true;
  };

  const publishArtwork = async (bindingId) => {
    setBusy(`artwork-publish-${bindingId}`);
    const result = await publishGameArtwork(game.id, bindingId, {}, silent).catch(() => null);
    setBusy('');
    if (!result?.game) {
      toast.error('Artwork publish was refused; the destination may contain unmanaged changes');
      return false;
    }
    replaceGame(result.game);
    setCompileError('');
    await refreshIntegrity();
    toast.success(result.publication?.wrote ? 'Artwork published to the game' : 'Artwork is already current');
    return true;
  };

  const publishMusic = async (bindingId, acknowledgeOverwrite = false) => {
    setBusy(`music-publish-${bindingId}`);
    let occupied = false;
    const result = await publishGameMusic(
      game.id,
      bindingId,
      acknowledgeOverwrite ? { acknowledgeOverwrite: true } : {},
      silent,
    ).catch((error) => {
      occupied = error?.code === 'PUBLISH_DEST_OCCUPIED';
      return null;
    });
    setBusy('');
    if (!result?.game) {
      if (occupied) {
        // Key the consent to the destination it was granted FOR, not just the
        // binding. The path is editable inline, and the server applies
        // `acknowledgeOverwrite` to whatever the binding points at when the
        // request lands — so a bare id would let consent for A authorize an
        // unguarded overwrite of B. Same invariant the sprite publish lane
        // states in PublishWorkflow.jsx.
        const target = (game.musicBindings || []).find((entry) => entry.id === bindingId);
        setMusicOverwrite({ bindingId, destinationPath: target?.destinationPath || '' });
        return false;
      }
      toast.error('Music publish failed');
      return false;
    }
    setMusicOverwrite(null);
    replaceGame(result.game);
    setCompileError('');
    await refreshIntegrity();
    toast.success(result.publication?.wrote ? 'Music published to the game' : 'Music is already current');
    return true;
  };

  if (loading) {
    // The detail workspace is a full-bleed h-full shell with its own bordered
    // bar; the index is a plain padded page. `id` is known before the fetch
    // settles, so each reserves the chrome its own loaded state renders.
    return id ? (
      <PageSkeleton
        header="bar"
        label="Loading Game workspace"
        fullHeight
        padded
        barClassName="px-4 py-3"
        bodyClassName="p-4"
        headerRowClass="flex flex-col justify-between gap-2 sm:flex-row sm:items-center"
        titleWidthClass="w-48"
        cards={3}
        sidebar={false}
      />
    ) : (
      <PageSkeleton
        label="Loading Game studio"
        titleWidthClass="w-32"
        showSubtitle
        showAction={false}
        cards={3}
        sidebar={false}
      />
    );
  }

  if (id && !game) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-port-border bg-port-card p-8 text-center">
        <h1 className="text-xl font-semibold text-white">Game not found</h1>
        <p className="mt-2 text-sm text-gray-400">This Game record may have been deleted.</p>
        <Link to="/game" className="mt-4 inline-flex min-h-[44px] items-center text-port-accent hover:underline">
          Back to Games
        </Link>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex items-center gap-3">
          <Gamepad2 className="h-7 w-7 text-port-accent" aria-hidden="true" />
          <div>
            <h1 className="text-2xl font-bold text-white">Game</h1>
            <p className="text-sm text-gray-400">Bind reusable art and music to a managed app.</p>
          </div>
        </div>

        <form onSubmit={create} className="mb-6 rounded-xl border border-port-border bg-port-card p-4">
          <h2 className="mb-3 font-semibold text-white">Create a Game workspace</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="game-name" className="mb-1 block text-xs text-gray-400">Game name</label>
              <input
                id="game-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                placeholder="Example Adventure"
                className="w-full min-h-[44px] rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white"
              />
            </div>
            <AppContextPicker
              apps={apps}
              value={appId}
              onChange={setAppId}
              label="Managed app"
              placeholder="Select an app…"
              includeDefaultOption
              showRepoPath={false}
            />
          </div>
          <button
            type="submit"
            disabled={busy === 'create' || !name.trim() || !appId}
            className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {busy === 'create' ? 'Creating…' : 'Create Game'}
          </button>
        </form>

        {games.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {games.map((entry) => {
              const linkedApp = apps.find((candidate) => candidate.id === entry.appId);
              return (
                <li key={entry.id}>
                  <Link
                    to={`/game/${entry.id}`}
                    className="block min-h-[110px] rounded-xl border border-port-border bg-port-card p-4 transition-colors hover:border-port-accent/60"
                  >
                    <div className="font-semibold text-white">{entry.name}</div>
                    <div className="mt-1 text-sm text-gray-400">{linkedApp?.name || 'Managed app unavailable'}</div>
                    <div className="mt-3 text-xs text-gray-500">
                      {entry.spriteBindings.length} sprites · {entry.musicBindings.length} tracks · {entry.artworkBindings?.length || 0} artwork · updated {timeAgo(entry.updatedAt)}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-port-border py-12 text-center text-sm text-gray-500">
            No Game workspaces yet.
          </div>
        )}
      </div>
    );
  }

  // Binding actions are namespaced so a new non-binding action (compile,
  // feedback, launch, …) doesn't have to be remembered in an exclusion list.
  const bindingBusy = /^(un)?bind-|^artwork-|^music-/.test(busy);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col justify-between gap-2 border-b border-port-border px-4 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/game"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-port-card hover:text-white"
            aria-label="All Games"
            title="All Games"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Gamepad2 className="h-6 w-6 shrink-0 text-port-accent" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="line-clamp-2 break-words text-xl font-bold text-white" title={game.name}>{game.name}</h1>
            <p className="truncate text-xs text-gray-400">{app?.name || 'Managed app unavailable'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>{game.spriteBindings.length} sprites</span>
          <span aria-hidden="true">·</span>
          <span>{game.musicBindings.length} {game.musicBindings.length === 1 ? 'music track' : 'music tracks'}</span>
          <span aria-hidden="true">·</span>
          <span>{game.artworkBindings?.length || 0} artwork</span>
        </div>
      </header>

      <TabPills
        tabs={DETAIL_TABS.map((tab) => ({ ...tab, count: tab.count?.(game) }))}
        activeTab={activeTab}
        onChange={setActiveTab}
        ariaLabel="Game workspace sections"
        controlsIdPrefix="game-panel"
        mobileDropdown
        mobileSelectId="game-section"
        className="px-4"
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-6xl">
          {activeTab === 'bundle' && (
            <div id="game-panel-bundle" role="tabpanel" aria-labelledby="tab-bundle">
              <GameCompilePanel
                game={game}
                sprites={sprites}
                tracks={tracks}
                integrity={integrity}
                loadingIntegrity={integrityLoading}
                compiling={busy === 'compile'}
                launching={busy === 'launch'}
                compileError={compileError}
                onCompile={compile}
                onLaunch={launch}
                onRetryIntegrity={refreshIntegrity}
              />
            </div>
          )}
          {activeTab === 'assets' && (
            <div id="game-panel-assets" role="tabpanel" aria-labelledby="tab-assets">
              <GameBindings
                game={game}
                sprites={sprites}
                tracks={tracks}
                gallery={gallery}
                integrity={integrity}
                busy={bindingBusy}
                onBindSprite={(spriteId) => mutate('bind-sprite', () => bindGameSprite(game.id, spriteId, silent), 'Sprite bound')}
                onUnbindSprite={(spriteId) => mutate('unbind-sprite', () => unbindGameSprite(game.id, spriteId, silent), 'Sprite unbound')}
                onBindMusic={(trackId) => mutate('bind-music', () => bindGameMusic(game.id, trackId, silent), 'Music bound')}
                onUpdateMusic={(bindingId, patch) => mutate(
                  `music-update-${bindingId}`,
                  () => updateGameMusic(game.id, bindingId, patch, silent),
                  'Music destination saved',
                )}
                onPublishMusic={publishMusic}
                musicOverwriteFor={musicOverwrite}
                onDismissMusicOverwrite={() => setMusicOverwrite(null)}
                onUnbindMusic={(bindingId) => mutate('unbind-music', () => unbindGameMusic(game.id, bindingId, silent), 'Music unbound')}
                onBindArtwork={(binding) => mutate(
                  'bind-artwork',
                  () => bindGameArtwork(game.id, binding, silent),
                  'Artwork bound',
                )}
                onUpdateArtwork={(bindingId, patch) => mutate(
                  `artwork-update-${bindingId}`,
                  () => updateGameArtwork(game.id, bindingId, patch, silent),
                  'Artwork details saved',
                )}
                onPublishArtwork={publishArtwork}
                onUnbindArtwork={(bindingId) => mutate(
                  'unbind-artwork',
                  () => unbindGameArtwork(game.id, bindingId, silent),
                  'Artwork unbound',
                )}
              />
            </div>
          )}
          {activeTab === 'feedback' && (
            <div id="game-panel-feedback" role="tabpanel" aria-labelledby="tab-feedback">
              <GameFeedback history={game.feedbackHistory} submitting={busy === 'feedback'} onSubmit={feedback} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
