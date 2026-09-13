/**
 * Decks page — deck index (Create → Decks).
 *
 * Lists every card deck (playing cards or tarot) with its render completion,
 * and creates a new one: name, kind, and an optional universe link whose cast,
 * places and objects the casting pass places onto the cards. The editor lives
 * at `/decks/:id`. Mirrors the Mood Boards index.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Globe, Plus, Spade, Trash2 } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import ProgressBar from '../components/ui/ProgressBar';
import toast from '../components/ui/Toast';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import EmptyState from '../components/EmptyState';
import { timeAgo } from '../utils/formatters';
import { DECK_KIND, DECK_KINDS, DECK_KIND_LABELS } from '../lib/decks';
import Pill from '../components/ui/Pill';
import { createDeck, deleteDeck, listDecks, listUniverseSummaries } from '../services/api';

const INPUT_CLASS = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

export default function Decks() {
  const navigate = useNavigate();
  const [decks, setDecks] = useState([]);
  const [universes, setUniverses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [confirmingId, setConfirmingId] = useState(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState(DECK_KIND.TAROT);
  const [universeId, setUniverseId] = useState('');
  const [seedStyle, setSeedStyle] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [rows, worlds] = await Promise.all([
      listDecks({ silent: true }).catch(() => null),
      listUniverseSummaries({ silent: true }).catch(() => []),
    ]);
    if (rows) setDecks(Array.isArray(rows) ? rows : []);
    else toast.error('Failed to load decks');
    setUniverses(Array.isArray(worlds) ? worlds : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (event) => {
    event.preventDefault();
    if (creating || !name.trim()) return;
    setCreating(true);
    const deck = await createDeck({
      name: name.trim(),
      kind,
      universeId: universeId || null,
      seedStyleFromUniverse: seedStyle,
    }, { silent: true }).catch((err) => { toast.error(`Failed to create deck: ${err.message}`); return null; });
    setCreating(false);
    if (!deck) return;
    navigate(`/decks/${deck.id}`);
  };

  const handleDelete = async (id) => {
    setConfirmingId(null);
    const ok = await deleteDeck(id, { silent: true }).then(() => true).catch(() => false);
    if (!ok) { toast.error('Failed to delete deck'); return; }
    setDecks((prev) => prev.filter((d) => d.id !== id));
    toast.success('Deck deleted');
  };

  const universeName = (id) => universes.find((u) => u.id === id)?.name || null;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <Spade className="w-6 h-6 text-port-accent" aria-hidden="true" />
        <h1 className="text-xl font-semibold text-white">Decks</h1>
      </div>
      <p className="text-sm text-gray-400 mb-4">
        Design a deck of playing cards or tarot cards: analyze a sample design into a style guide, write or generate a prompt per card, and render single cards or the whole deck with any image backend.
      </p>

      <form onSubmit={handleCreate} className="bg-port-card border border-port-border rounded-md p-3 mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_160px_1fr_auto] lg:items-end">
        <div>
          <label htmlFor="deck-new-name" className="block text-xs text-gray-400 mb-1">Deck name</label>
          <input id="deck-new-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Swarm Safe" className={INPUT_CLASS} />
        </div>
        <div>
          <label htmlFor="deck-new-kind" className="block text-xs text-gray-400 mb-1">Kind</label>
          <select id="deck-new-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={INPUT_CLASS}>
            {DECK_KINDS.map((k) => <option key={k} value={k}>{DECK_KIND_LABELS[k]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="deck-new-universe" className="block text-xs text-gray-400 mb-1">Universe (optional)</label>
          <select id="deck-new-universe" value={universeId} onChange={(e) => setUniverseId(e.target.value)} className={INPUT_CLASS}>
            <option value="">— none —</option>
            {universes.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {universeId ? (
            <label htmlFor="deck-new-seed" className="mt-1.5 flex items-center gap-2 text-xs text-gray-400">
              <input id="deck-new-seed" type="checkbox" checked={seedStyle} onChange={(e) => setSeedStyle(e.target.checked)} />
              Seed the style guide from this universe
            </label>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="flex min-h-[44px] items-center justify-center gap-1.5 px-3 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          New Deck
        </button>
      </form>

      {loading ? (
        <PageSkeleton header="none" label="Loading decks" cards={3} sidebar={false} />
      ) : decks.length === 0 ? (
        <EmptyState
          icon={Spade}
          title="No decks yet"
          message="Name a deck above, pick playing cards or tarot, and optionally link a universe so its cast lands on the cards."
        />
      ) : (
        <ul className="space-y-2">
          {decks.map((deck) => {
            const c = deck.completion || {};
            const linked = universeName(deck.universeId);
            return (
              <li key={deck.id} className="bg-port-card border border-port-border rounded-md overflow-hidden">
                {confirmingId === deck.id ? (
                  <InlineConfirmRow
                    variant="separator"
                    question={`Delete "${deck.name}"? Its cards and prompts are removed; rendered images stay in the gallery.`}
                    onConfirm={() => handleDelete(deck.id)}
                    onCancel={() => setConfirmingId(null)}
                  />
                ) : null}
                <div className="flex items-center gap-3 p-3">
                  <Link to={`/decks/${deck.id}`} className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white font-medium truncate">{deck.name}</span>
                      <Pill tone="context" size="xs">{DECK_KIND_LABELS[deck.kind] || deck.kind}</Pill>
                      {linked ? (
                        <span className="inline-flex items-center gap-1 text-xs text-gray-400"><Globe className="w-3 h-3" aria-hidden="true" />{linked}</span>
                      ) : null}
                    </div>
                    <div className="mt-2 max-w-md">
                      <ProgressBar percent={c.percent || 0} label={`${deck.name} render progress`} tone={c.percent === 100 ? 'success' : 'accent'} />
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 flex-wrap">
                      <span>{c.rendered ?? 0}/{c.total ?? 0} rendered</span>
                      <span>{c.prompted ?? 0} prompted</span>
                      {c.inFlight ? <span className="text-port-accent">{c.inFlight} rendering</span> : null}
                      {c.failed ? <span className="text-port-error">{c.failed} failed</span> : null}
                      <span>· {timeAgo(deck.updatedAt)}</span>
                    </div>
                  </Link>
                  <button
                    type="button"
                    onClick={() => setConfirmingId(deck.id)}
                    title="Delete deck"
                    aria-label={`Delete ${deck.name}`}
                    className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-port-error transition-colors"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
