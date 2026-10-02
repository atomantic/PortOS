import { useEffect, useState } from 'react';
import { listMoodBoardNames } from '../../services/apiMoodBoard.js';

/**
 * Pick an existing mood board for an autonomous run to reuse, or leave it on
 * "Generate from the prompt". A saved id whose board no longer exists stays
 * listed so the saved choice is never silently dropped.
 */
export default function MoodBoardPicker({ id, value, onChange }) {
  const [boards, setBoards] = useState([]);
  useEffect(() => {
    let live = true;
    listMoodBoardNames({ silent: true })
      .then((rows) => { if (live) setBoards(Array.isArray(rows) ? rows : []); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const missing = value && !boards.some((b) => b.id === value);

  return (
    <div>
      <label htmlFor={id} className="block text-xs text-port-text-muted mb-1">Mood board</label>
      <select
        id={id}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
      >
        <option value="">Generate one from the prompt</option>
        {missing && <option value={value}>{value} (not found)</option>}
        {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <p className="text-[11px] text-port-text-muted mt-1">Pick an existing board to reuse its style instead of generating a new one.</p>
    </div>
  );
}
