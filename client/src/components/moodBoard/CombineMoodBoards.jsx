import { useCallback, useState } from 'react';
import Modal from '../ui/Modal';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';
import useVisionModelIds from '../../hooks/useVisionModelIds';
import { isVisionCapableCliProvider, visionLocalModelFilter } from '../../utils/providers';

import { combineMoodBoards } from '../../services/apiMoodBoard';

const visionProviderFilter = provider => provider.enabled && (provider.type === 'api' || isVisionCapableCliProvider(provider));

export default function CombineMoodBoards({ boards, onClose, onCreated }) {
  const [firstId, setFirstId] = useState('');
  const [secondId, setSecondId] = useState('');
  const [name, setName] = useState('Composite board');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [effort, setEffort] = useState('');
  const { idsByProvider: visionIds } = useVisionModelIds(true);
  const modelFilter = useCallback((id, provider) => visionLocalModelFilter(id, provider, visionIds), [visionIds]);
  const { providers, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel, loading } = useProviderModels({
    filter: visionProviderFilter, silent: true, withEffort: true, modelFilter,
  });
  const missing = boards.filter(board => [firstId, secondId].includes(board.id) && !board.style?.prompt?.trim());
  const canSubmit = !busy && !loading && selectedProviderId && firstId && secondId && firstId !== secondId && name.trim();
  const fieldClass = 'w-full min-h-[44px] rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white';

  const submit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    const board = await combineMoodBoards({ name: name.trim(), boardIds: [firstId, secondId], providerId: selectedProviderId, model: selectedModel || undefined, effort: effort || undefined, analyzeMissing: missing.length > 0 }, { silent: true })
      .catch((err) => { setError(err.message || 'Could not combine mood boards'); return null; });
    setBusy(false);
    if (board) onCreated(board);
  };

  return (
    <Modal open onClose={onClose} closeOnEsc={!busy} closeOnBackdrop={!busy} ariaLabelledBy="combine-boards-title" panelClassName="bg-port-card border border-port-border rounded-xl shadow-xl">
      <form onSubmit={submit} className="p-4 space-y-4">
        <h2 id="combine-boards-title" className="text-lg font-semibold text-white">Combine mood boards</h2>
        <p className="text-sm text-gray-400">Synthesize a unique style from two boards, ready for generating new images. The new board starts without pins. Choose the model to combine their styles and analyze missing source styles.</p>
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
        {missing.length > 0 ? <p className="text-sm text-port-warning">Missing styles: {missing.map(board => board.name).join(', ')}. Creating this board will analyze unprompted items and save a style on each missing source board first.</p> : null}
        <ProviderModelSelector
          providers={providers} selectedProviderId={selectedProviderId} selectedModel={selectedModel}
          availableModels={availableModels} onProviderChange={setSelectedProviderId} onModelChange={setSelectedModel}
          effort={effort} onEffortChange={setEffort} disabled={busy} loading={loading}
        />
        {!loading && !providers.length ? <p role="alert" className="text-sm text-port-warning">Enable a vision-capable provider in Settings → Providers to combine boards.</p> : null}
        {error ? <p role="alert" className="text-sm text-port-error">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="min-h-[44px] px-3 text-sm text-gray-400">Cancel</button>
          <button type="submit" disabled={!canSubmit} className="min-h-[44px] px-3 rounded bg-port-accent text-white text-sm disabled:opacity-50">
            {busy ? 'Analyzing and combining…' : 'Create composite board'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
