import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Boxes, Gamepad2, Images, MessageSquare, Plus } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from '../components/ui/Toast';
import AppContextPicker from '../components/AppContextPicker.jsx';
import GameBindings from '../components/games/GameBindings.jsx';
import GameCompilePanel from '../components/games/GameCompilePanel.jsx';
import GameFeedback from '../components/games/GameFeedback.jsx';
import TabPills from '../components/ui/TabPills.jsx';
import useDrawerTab from '../hooks/useDrawerTab.js';
import {
  bindGameMusic,
  bindGameSprite,
  compileGameAssets,
  createGame,
  getApps,
  getGame,
  getGameIntegrity,
  listGames,
  listSpriteRecords,
  listTracks,
  launchNativeApp,
  requestGameFeedback,
  startApp,
  unbindGameMusic,
  unbindGameSprite,
} from '../services/api.js';
import { timeAgo } from '../utils/formatters.js';

const silent = { silent: true };
const DETAIL_TABS = [
  { id: 'bundle', label: 'Bundle', icon: Boxes },
  {
    id: 'assets',
    label: 'Assets',
    icon: Images,
    count: (game) => game.spriteBindings.length + game.musicBindings.length,
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

  const load = useCallback(async () => {
    setLoading(true);
    const result = await Promise.all([
      listGames(silent),
      getApps(silent),
      listSpriteRecords(silent),
      listTracks(silent),
    ]).catch(() => null);
    if (!result) {
      toast.error('Failed to load the Game studio');
    } else {
      const [gameRows, appRows, spriteRows, trackRows] = result;
      setGames(Array.isArray(gameRows) ? gameRows : []);
      setApps((Array.isArray(appRows) ? appRows : []).filter((app) => !app.archived));
      setSprites(Array.isArray(spriteRows) ? spriteRows : []);
      setTracks(Array.isArray(trackRows) ? trackRows : []);
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
  const integrity = integrityFor?.gameId === id ? integrityFor.data : null;
  const integrityLoading = integrityFetching || integrityFor?.gameId !== id;

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

  if (loading) {
    return <div className="py-12 text-center text-sm text-gray-400">Loading Game studio…</div>;
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
                      {entry.spriteBindings.length} sprites · {entry.musicBindings.length} tracks · updated {timeAgo(entry.updatedAt)}
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
  const bindingBusy = /^(un)?bind-/.test(busy);
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
        <div>
          <Link to="/game" className="mb-2 inline-flex min-h-[44px] items-center gap-2 text-sm text-gray-400 hover:text-white">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            All Games
          </Link>
          <div className="flex items-center gap-3">
            <Gamepad2 className="h-7 w-7 text-port-accent" aria-hidden="true" />
            <div>
              <h1 className="text-2xl font-bold text-white">{game.name}</h1>
              <p className="text-sm text-gray-400">{app?.name || 'Managed app unavailable'}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>{game.spriteBindings.length} sprites</span>
          <span aria-hidden="true">·</span>
          <span>{game.musicBindings.length} {game.musicBindings.length === 1 ? 'music track' : 'music tracks'}</span>
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
      />

      {activeTab === 'bundle' && (
        <div id="game-panel-bundle" role="tabpanel" aria-labelledby="tab-bundle">
          <GameCompilePanel
            game={game}
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
            integrity={integrity}
            busy={bindingBusy}
            onBindSprite={(spriteId) => mutate('bind-sprite', () => bindGameSprite(game.id, spriteId, silent), 'Sprite bound')}
            onUnbindSprite={(spriteId) => mutate('unbind-sprite', () => unbindGameSprite(game.id, spriteId, silent), 'Sprite unbound')}
            onBindMusic={(trackId) => mutate('bind-music', () => bindGameMusic(game.id, trackId, silent), 'Music bound')}
            onUnbindMusic={(bindingId) => mutate('unbind-music', () => unbindGameMusic(game.id, bindingId, silent), 'Music unbound')}
          />
        </div>
      )}
      {activeTab === 'feedback' && (
        <div id="game-panel-feedback" role="tabpanel" aria-labelledby="tab-feedback">
          <GameFeedback history={game.feedbackHistory} submitting={busy === 'feedback'} onSubmit={feedback} />
        </div>
      )}
    </div>
  );
}
