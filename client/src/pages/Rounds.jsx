/**
 * Rounds page — a cappella round workbench index.
 *
 * Lists every round the user is writing or learning and lets them create, open,
 * or delete any of them. The heavy editor lives at `/rounds/:id`; the learning
 * reference (dirge rhythm shapes, the layer ladder, notation help) lives at
 * `/rounds/guide`. Mirrors the Universes index — a plain padded+scrolling page
 * (NOT full-width), one card/row per round.
 */

import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Music, Plus, Trash2, BookOpen, CheckCircle2, Circle, Wand2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { timeAgo } from '../utils/formatters';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { listRounds, createRound, deleteRound, generateRound } from '../services/api';
import { RHYTHM_SHAPES } from '../lib/songCraft';

const shapeLabel = (id) => RHYTHM_SHAPES.find((s) => s.id === id)?.label || null;

export default function Rounds() {
  const navigate = useNavigate();
  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  // Inline delete confirm (no window.confirm, no two-click-arm) — one row armed
  // at a time via useConfirmDelete + <ConfirmButtonPair>.
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  useEffect(() => {
    listRounds({ silent: true })
      .then((data) => setRounds(Array.isArray(data?.rounds) ? data.rounds : []))
      .catch((err) => toast.error(err?.message || 'Failed to load rounds'))
      .finally(() => setLoading(false));
  }, []);

  const [create, creating] = useAsyncAction(async () => {
    const name = title.trim();
    if (!name) { toast.error('Give the round a title'); return null; }
    const data = await createRound({ title: name, artist: artist.trim() }, { silent: true });
    const round = data?.round;
    // A blank new round has nothing to read — open straight into edit mode.
    if (round) navigate(`/rounds/${round.id}?mode=edit`);
    return round;
  }, { errorMessage: 'Failed to create round' });

  // Generate a full draft from the title/artist as a brief, persist it, then
  // open the editor on the new round. Two server calls (generate → create) keep
  // the AI service stateless about storage; the editor's own Generate/Expand
  // buttons drive subsequent rounds. NOTE: the generate endpoint returns the
  // drafted arrangement under `song` (the AI payload shape); create returns the
  // stored record under `round`.
  const [generate, generating] = useAsyncAction(async () => {
    const name = title.trim();
    const data = await generateRound(
      { title: name || undefined, artist: artist.trim() || undefined },
      { silent: true },
    );
    const fields = data?.song;
    if (!fields) { toast.error('Generation produced nothing — try again'); return null; }
    const created = await createRound(fields, { silent: true });
    const round = created?.round;
    // Unlike a blank create, a generated draft already has lyrics — open the
    // read view so the user sees the result, then toggle to Edit to refine.
    if (round) navigate(`/rounds/${round.id}`);
    return round;
  }, { errorMessage: 'Failed to generate round' });

  const onDelete = useCallback((round) => confirmDelete(() =>
    deleteRound(round.id, { silent: true })
      .then(() => setRounds((prev) => prev.filter((s) => s.id !== round.id)))
      .catch((err) => toast.error(err?.message || 'Failed to delete round')),
  ), [confirmDelete]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-3">
          <Music className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Rounds</h1>
        </div>
        <Link
          to="/rounds/guide"
          className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50"
        >
          <BookOpen size={16} />
          Learning Guide
        </Link>
      </div>
      <p className="text-sm text-gray-400 mb-6">
        Write and learn a cappella rounds — dirges, ballads, and harmonies. Track lyrics,
        rhythm shapes, and the voice layers you're stacking.
      </p>

      {/* Create form */}
      <form
        onSubmit={(e) => { e.preventDefault(); create(); }}
        className="bg-port-card border border-port-border rounded-lg p-4 mb-6 flex flex-col sm:flex-row gap-3 sm:items-end"
      >
        <div className="flex-1">
          <label htmlFor="round-title" className="block text-xs text-gray-400 mb-1">Title</label>
          <input
            id="round-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. 500 Miles"
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none"
          />
        </div>
        <div className="flex-1">
          <label htmlFor="round-artist" className="block text-xs text-gray-400 mb-1">Artist (optional)</label>
          <input
            id="round-artist"
            type="text"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder="e.g. Peter, Paul and Mary"
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={creating || generating}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
          >
            <Plus size={16} />
            New Round
          </button>
          <button
            type="button"
            onClick={() => generate()}
            disabled={creating || generating}
            title="Draft a full arrangement with AI from the title/artist above"
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
          >
            <Wand2 size={16} />
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </form>

      {/* List */}
      {loading ? (
        <p className="text-sm text-gray-500">Loading rounds…</p>
      ) : rounds.length === 0 ? (
        <p className="text-sm text-gray-500">No rounds yet — write your first above.</p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {rounds.map((round) => {
            const shape = shapeLabel(round.rhythmShapeId);
            const layerCount = round.layers?.length || 0;
            return (
              <li
                key={round.id}
                className="group bg-port-card border border-port-border rounded-lg flex items-center gap-3 px-4 py-3 hover:border-port-accent/50"
              >
                <Link to={`/rounds/${round.id}`} className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {round.learned
                      ? <CheckCircle2 size={16} className="text-port-success shrink-0" aria-label="Learned" />
                      : <Circle size={16} className="text-gray-600 shrink-0" aria-label="In progress" />}
                    <span className="flex-1 min-w-0 text-white font-medium truncate" title={round.title}>{round.title}</span>
                    {round.builtIn && (
                      <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-port-accent/10 text-port-accent border border-port-accent/20">
                        Built-in
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500 mt-1 pl-6">
                    {round.artist && <span className="text-gray-400">{round.artist}</span>}
                    {round.key && <span>Key: {round.key}</span>}
                    {round.tempo && <span>{round.tempo} BPM</span>}
                    {shape && <span>{shape}</span>}
                    {layerCount > 0 && <span>{layerCount} layer{layerCount === 1 ? '' : 's'}</span>}
                    {round.updatedAt && <span>Edited {timeAgo(round.updatedAt)}</span>}
                  </div>
                </Link>
                {isConfirming(round.id) ? (
                  <ConfirmButtonPair
                    prompt="Delete?"
                    className="shrink-0"
                    ariaLabel={`Confirm delete ${round.title}`}
                    onConfirm={() => onDelete(round)}
                    onCancel={cancelDelete}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => requestDelete(round.id)}
                    className="p-2 shrink-0 text-gray-500 hover:text-port-error"
                    aria-label={`Delete ${round.title}`}
                    title="Delete round"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
