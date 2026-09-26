import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listMoodBoardNames, listUniverseNames, listUniverseStyles } from '../../services/api';
import { BOARD_FOLLOW_UNIVERSE, BOARD_NONE } from '../../lib/styleSourceChoice.js';

export { BOARD_FOLLOW_UNIVERSE, BOARD_NONE };

const rowsOf = (rows) => (Array.isArray(rows) ? rows : []);

/** Load the universes, their style tokens (keyed by id), and the mood boards once. */
export function useStyleSourceLists() {
  const [lists, setLists] = useState({ universes: [], universeStyles: {}, boards: [], loaded: false });
  useEffect(() => {
    let active = true;
    Promise.all([
      listUniverseNames({ silent: true }).catch(() => []),
      listUniverseStyles({ silent: true }).catch(() => []),
      listMoodBoardNames({ silent: true }).catch(() => []),
    ]).then(([universes, styles, boards]) => {
      if (!active) return;
      setLists({
        universes: rowsOf(universes),
        universeStyles: Object.fromEntries(rowsOf(styles).map((row) => [row.id, row])),
        boards: rowsOf(boards),
        loaded: true,
      });
    });
    return () => { active = false; };
  }, []);
  return lists;
}

/**
 * The universe + mood-board selects, the chosen universe's embrace/avoid tags,
 * and the empty-state hints. Fully controlled; `lists` comes from
 * `useStyleSourceLists()` so a page that needs the lists elsewhere loads once.
 */
export default function UniverseMoodBoardPicker({
  lists, universeId, moodBoardChoice, onUniverseChange, onBoardChoiceChange,
  idPrefix, labelClass, inputClass, universeLabel = 'Universe',
}) {
  const { universes, universeStyles, boards, loaded } = lists;
  const activeStyle = universeId ? universeStyles[universeId] : null;
  const embrace = activeStyle?.influences?.embrace || [];
  const avoid = activeStyle?.influences?.avoid || [];
  // Keep a stored choice selectable before the lists load (or after the
  // record it names was deleted), so the select never shows another value.
  const universeKnown = !universeId || universes.some((u) => u.id === universeId);
  const boardKnown = moodBoardChoice === BOARD_FOLLOW_UNIVERSE || moodBoardChoice === BOARD_NONE
    || boards.some((b) => b.id === moodBoardChoice);

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-universe`} className={labelClass}>{universeLabel}</label>
          <select id={`${idPrefix}-universe`} value={universeId} onChange={(e) => onUniverseChange(e.target.value)} className={inputClass}>
            <option value="">No universe</option>
            {!universeKnown && <option value={universeId}>{universeId}</option>}
            {universes.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-board`} className={labelClass}>Mood board</label>
          <select id={`${idPrefix}-board`} value={moodBoardChoice} onChange={(e) => onBoardChoiceChange(e.target.value)} className={inputClass}>
            <option value={BOARD_FOLLOW_UNIVERSE}>Universe&apos;s linked board</option>
            <option value={BOARD_NONE}>No mood board</option>
            {!boardKnown && <option value={moodBoardChoice}>{moodBoardChoice}</option>}
            {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      </div>
      {(embrace.length > 0 || avoid.length > 0) && (
        <div className="flex flex-wrap gap-1 text-[11px]" aria-label="Universe style tags">
          {embrace.slice(0, 12).map((token) => (
            <span key={`e-${token}`} className="rounded bg-port-accent/15 px-1.5 py-0.5 text-port-accent">{token}</span>
          ))}
          {avoid.slice(0, 6).map((token) => (
            <span key={`a-${token}`} className="rounded bg-port-error/15 px-1.5 py-0.5 text-port-error line-through">{token}</span>
          ))}
        </div>
      )}
      {universeId && loaded && universeKnown && !activeStyle && (
        <p className="text-xs text-gray-500">
          This universe has no style tokens yet, so only its notes and style references will be used.{' '}
          <Link to={`/universes/${encodeURIComponent(universeId)}`} className="text-port-accent hover:underline">Edit its style guide</Link>
        </p>
      )}
      {loaded && boards.length === 0 && (
        <p className="text-xs text-gray-500">
          No mood boards yet. <Link to="/mood-boards" className="text-port-accent hover:underline">Create a mood board</Link> to collect style references.
        </p>
      )}
    </>
  );
}
