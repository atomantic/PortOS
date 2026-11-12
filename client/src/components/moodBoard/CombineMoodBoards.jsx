import { useState } from 'react';
import Modal from '../ui/Modal';
import { combineMoodBoards } from '../../services/apiMoodBoard';

export default function CombineMoodBoards({ boards, onClose, onCreated }) {
  const [firstId, setFirstId] = useState('');
  const [secondId, setSecondId] = useState('');
  const [name, setName] = useState('Composite board');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fieldClass = 'w-full min-h-[44px] rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white';

  const submit = async (event) => {
    event.preventDefault();
    if (busy || !firstId || !secondId || firstId === secondId || !name.trim()) return;
    setBusy(true);
    setError('');
    const board = await combineMoodBoards({ name: name.trim(), boardIds: [firstId, secondId] }, { silent: true })
      .catch((err) => { setError(err.message || 'Could not combine mood boards'); return null; });
    setBusy(false);
    if (board) onCreated(board);
  };

  return (
    <Modal open onClose={onClose} closeOnEsc={!busy} closeOnBackdrop={!busy} ariaLabelledBy="combine-boards-title">
      <form onSubmit={submit} className="p-4 space-y-4">
        <h2 id="combine-boards-title" className="text-lg font-semibold text-white">Combine mood boards</h2>
        <p className="text-sm text-gray-400">Create an independent board with both sets of pins and saved style prompts. Originals stay unchanged. No AI calls are made. Edit or render the combined style on the new board, or analyze its pins to compose a fresh style.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="combine-first-board" className="block text-sm text-gray-400 mb-1">First board</label>
            <select id="combine-first-board" value={firstId} onChange={event => setFirstId(event.target.value)} disabled={busy} required className={fieldClass}>
              <option value="">Choose a board</option>
              {boards.map(board => <option key={board.id} value={board.id} disabled={board.id === secondId}>{board.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="combine-second-board" className="block text-sm text-gray-400 mb-1">Second board</label>
            <select id="combine-second-board" value={secondId} onChange={event => setSecondId(event.target.value)} disabled={busy} required className={fieldClass}>
              <option value="">Choose a board</option>
              {boards.map(board => <option key={board.id} value={board.id} disabled={board.id === firstId}>{board.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="combine-board-name" className="block text-sm text-gray-400 mb-1">New board name</label>
          <input id="combine-board-name" value={name} onChange={event => setName(event.target.value)} disabled={busy} maxLength={200} required className={fieldClass} />
        </div>
        {error ? <p role="alert" className="text-sm text-port-error">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="min-h-[44px] px-3 text-sm text-gray-400">Cancel</button>
          <button type="submit" disabled={busy || !firstId || !secondId || firstId === secondId || !name.trim()} className="min-h-[44px] px-3 rounded bg-port-accent text-white text-sm disabled:opacity-50">
            {busy ? 'Combining…' : 'Create composite board'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
