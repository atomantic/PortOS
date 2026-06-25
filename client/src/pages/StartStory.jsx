import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Rocket, Lightbulb, FileInput, NotebookPen } from 'lucide-react';
import { listUniverses } from '../services/api';
import toast from '../components/ui/Toast';

// The "Start a Story" onramp (issue #1633, Phase 1). One clear front door that
// answers "how do you want to begin?" and routes into the existing engines
// unchanged — Story Builder (idea), Importer (existing work), Writers Room
// (prose). It also asks the universe question up front: start fresh, or attach
// the new story to an existing universe. The chosen universe is forwarded to
// the engines that already accept it (?universeId=…); prose-mode binding lands
// in a later phase (Writers Room works have no universe link yet).
const MODES = [
  {
    id: 'idea',
    title: 'From an idea',
    icon: Lightbulb,
    desc: 'Start with a seed idea and let the guided Story Builder shape it into a universe, series, and issues.',
    to: '/story-builder',
    consumesUniverse: true,
  },
  {
    id: 'import',
    title: 'From an existing work',
    icon: FileInput,
    desc: 'Bring in a finished prose or script. The Importer reverse-engineers canon, arc, and an issue split seeded with your text.',
    to: '/importer',
    consumesUniverse: true,
  },
  {
    id: 'prose',
    title: 'From writing prose',
    icon: NotebookPen,
    desc: 'Open the Writers Room and draft freely, then promote into the production pipeline when you’re ready.',
    to: '/writers-room',
    consumesUniverse: false,
  },
];

export default function StartStory() {
  const navigate = useNavigate();
  const [universes, setUniverses] = useState([]);
  const [useExisting, setUseExisting] = useState(false);
  const [universeId, setUniverseId] = useState('');

  useEffect(() => {
    let cancelled = false;
    // silent: the custom catch below owns the toast (CLAUDE.md). A failed load
    // just leaves the "use an existing universe" option empty — the onramp
    // still works in "start fresh" mode.
    listUniverses({ silent: true })
      .catch((err) => {
        toast.error(err?.message || 'Failed to load universes');
        return [];
      })
      .then((u) => {
        if (cancelled) return;
        setUniverses(Array.isArray(u) ? u : []);
      });
    return () => { cancelled = true; };
  }, []);

  // A universe must actually be picked before the mode cards can attach it.
  const needsUniversePick = useExisting && !universeId;

  const go = (mode) => {
    if (needsUniversePick) return;
    const attach = useExisting && universeId && mode.consumesUniverse;
    const query = attach ? `?universeId=${encodeURIComponent(universeId)}` : '';
    navigate(`${mode.to}${query}`);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Rocket className="w-6 h-6 text-port-accent" /> Start a Story
        </h1>
        <p className="text-gray-400 mt-1">
          How do you want to begin? Every path lands in the same place — a universe, a series, and the
          production pipeline — so pick whichever door fits where your story is today.
        </p>
      </header>

      {/* Universe choice, asked up front for all three modes. */}
      <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">Which universe?</h2>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input
              type="radio"
              name="universe-choice"
              checked={!useExisting}
              onChange={() => { setUseExisting(false); setUniverseId(''); }}
              className="accent-port-accent"
            />
            Start fresh
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input
              type="radio"
              name="universe-choice"
              checked={useExisting}
              onChange={() => setUseExisting(true)}
              className="accent-port-accent"
              disabled={universes.length === 0}
            />
            Use an existing universe
          </label>
          {useExisting && (
            <select
              id="start-story-universe"
              aria-label="Existing universe"
              value={universeId}
              onChange={(e) => setUniverseId(e.target.value)}
              className="bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-gray-200 sm:ml-auto"
            >
              <option value="">Select a universe…</option>
              {universes.map((u) => (
                <option key={u.id} value={u.id}>{u.name || '(untitled universe)'}</option>
              ))}
            </select>
          )}
        </div>
        {needsUniversePick && (
          <p className="text-xs text-port-warning">Pick a universe above to continue, or switch to “Start fresh.”</p>
        )}
      </section>

      {/* The three intake modes. */}
      <section className="grid gap-4 sm:grid-cols-3">
        {MODES.map((mode) => {
          const Icon = mode.icon;
          const attaches = useExisting && universeId && mode.consumesUniverse;
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => go(mode)}
              disabled={needsUniversePick}
              className={`text-left bg-port-card border border-port-border rounded-lg p-4 space-y-2 transition-colors ${
                needsUniversePick
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:border-port-accent'
              }`}
            >
              <Icon className="w-6 h-6 text-port-accent" />
              <h3 className="font-semibold text-gray-100">{mode.title}</h3>
              <p className="text-sm text-gray-400">{mode.desc}</p>
              {attaches && (
                <p className="text-xs text-port-success">Will attach to the selected universe.</p>
              )}
              {useExisting && universeId && !mode.consumesUniverse && (
                <p className="text-xs text-gray-500">Universe linking for prose drafts is coming in a later phase.</p>
              )}
            </button>
          );
        })}
      </section>
    </div>
  );
}
