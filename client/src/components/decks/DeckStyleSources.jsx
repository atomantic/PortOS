import { useState } from 'react';
import { getUniverse, listMoodBoardNames } from '../../services/api';
import useAsyncAction from '../../hooks/useAsyncAction';
import useMounted from '../../hooks/useMounted';
import MoodBoardStyleSynthesis from '../universeBuilder/MoodBoardStyleSynthesis';

/** One-time style imports; selecting a source never changes its original record. */
export default function DeckStyleSources({ deck, onPatch }) {
  const [boards, setBoards] = useState(null);
  const [boardId, setBoardId] = useState('');
  const mounted = useMounted();
  const [importUniverse, importing] = useAsyncAction(async () => {
    const universe = await getUniverse(deck.universeId, { silent: true });
    if (!mounted.current) return;
    await onPatch({
      styleNotes: universe.styleNotes ?? '',
      influences: {
        embrace: universe.influences?.embrace ?? [],
        avoid: universe.influences?.avoid ?? [],
      },
    });
  });
  const [loadBoards, loading] = useAsyncAction(async () => {
    const names = await listMoodBoardNames({ silent: true });
    if (mounted.current) setBoards(names);
  });

  return (
    <div className="space-y-2 rounded border border-port-border p-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!deck.universeId || importing} onClick={importUniverse}
          className="min-h-[38px] rounded border border-port-accent/40 px-2.5 text-xs text-port-accent disabled:opacity-50">
          {importing ? 'Importing…' : 'Re-import universe style'}
        </button>
        {boards === null ? (
          <button type="button" disabled={loading} onClick={loadBoards}
            className="min-h-[38px] rounded border border-port-accent/40 px-2.5 text-xs text-port-accent disabled:opacity-50">
            {loading ? 'Loading mood boards…' : 'Apply mood board style'}
          </button>
        ) : null}
      </div>
      <p className="text-[11px] text-gray-500">
        Import replaces art direction, style prompt and negative prompt. Card layout, orientation and existing images stay unchanged.
        {!deck.universeId ? ' Link a universe below to import its latest style.' : ''}
      </p>
      {boards !== null ? (
        <div className="space-y-2">
          <label htmlFor="deck-style-board" className="block text-xs text-gray-400">Mood board style source</label>
          <select id="deck-style-board" value={boardId} onChange={(event) => setBoardId(event.target.value)}
            className="w-full min-w-0 rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white">
            <option value="">Choose a mood board</option>
            {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
          </select>
          {boards.length === 0 ? <p className="text-xs text-gray-500">No mood boards yet. <a href="/mood-boards" className="text-port-accent">Create a mood board</a> to collect style references.</p> : null}
          <MoodBoardStyleSynthesis key={boardId} boardId={boardId} universeId={deck.id} targetLabel="deck"
            styleNotes={deck.styleNotes} influences={deck.influences} saved={!importing} onAdopt={onPatch} />
        </div>
      ) : null}
    </div>
  );
}
