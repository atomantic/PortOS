import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Gamepad2, Plus } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from '../components/ui/Toast';
import AppContextPicker from '../components/AppContextPicker.jsx';
import GameBindings from '../components/games/GameBindings.jsx';
import GameCompilePanel from '../components/games/GameCompilePanel.jsx';
import GameFeedback from '../components/games/GameFeedback.jsx';
import {
  bindGameMusic,
  bindGameSprite,
  compileGameAssets,
  createGame,
  getApps,
  getGame,
  listGames,
  listSpriteRecords,
  listTracks,
  requestGameFeedback,
  unbindGameMusic,
  unbindGameSprite,
} from '../services/api.js';
import { timeAgo } from '../utils/formatters.js';

const silent = { silent: true };

export default function Game() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [games, setGames] = useState([]);
  const [apps, setApps] = useState([]);
  const [sprites, setSprites] = useState([]);
  const [tracks, setTracks] = useState([]);
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
    if (successMessage) toast.success(successMessage);
    return true;
  };

  const compile = async () => {
    setBusy('compile');
    const result = await compileGameAssets(game.id, silent).catch(() => null);
    const refreshed = result ? await getGame(game.id, silent).catch(() => null) : null;
    setBusy('');
    if (!result || !refreshed) { toast.error('Bundle compilation failed'); return; }
    replaceGame(refreshed);
    toast.success(result.created ? `Compiled bundle v${result.version}` : `Bundle v${result.version} is already current`);
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

  const bindingBusy = Boolean(busy && busy !== 'compile' && busy !== 'feedback');
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header>
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
      </header>

      <GameBindings
        game={game}
        sprites={sprites}
        tracks={tracks}
        busy={bindingBusy}
        onBindSprite={(spriteId) => mutate('bind-sprite', () => bindGameSprite(game.id, spriteId, silent), 'Sprite bound')}
        onUnbindSprite={(spriteId) => mutate('unbind-sprite', () => unbindGameSprite(game.id, spriteId, silent), 'Sprite unbound')}
        onBindMusic={(trackId) => mutate('bind-music', () => bindGameMusic(game.id, trackId, silent), 'Music bound')}
        onUnbindMusic={(bindingId) => mutate('unbind-music', () => unbindGameMusic(game.id, bindingId, silent), 'Music unbound')}
      />
      <GameCompilePanel game={game} compiling={busy === 'compile'} onCompile={compile} />
      <GameFeedback history={game.feedbackHistory} submitting={busy === 'feedback'} onSubmit={feedback} />
    </div>
  );
}
