// Fork a character from its locked reference (#sprite-i2i): creates a new
// sprite whose first render is generated image+text→image from THIS sprite's
// reference plus a required prompt describing the change. The server picks the
// seed (the turnaround sheet when the source has one, else its main) and the
// fork enters the same turnaround-first workflow (#2979). Thin form over
// forkSpriteRecord → the server creates the record and queues that render;
// on success we hand the new record back so the page can navigate to it.

import { useEffect, useState } from 'react';
import { GitFork, RefreshCw, X } from 'lucide-react';
import Modal from '../ui/Modal';
import toast from '../ui/Toast';
import SpritePreview from './SpritePreview.jsx';
import { forkSpriteRecord } from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';

export default function ForkSpriteModal({ open, onClose, source, referencePath, fromTurnaround = false, backends, mode, onForked }) {
  const [name, setName] = useState(`${source?.name || ''} fork`);
  const [id, setId] = useState('');
  const [designPrompt, setDesignPrompt] = useState('');
  const [forkMode, setForkMode] = useState(mode || '');
  const [strength, setStrength] = useState(0.65);

  // The page's image `mode` can resolve AFTER this modal mounts (settings fetch
  // lands after the locked-main detail renders, and the modal is mounted
  // eagerly while `mainLocked`). Backfill an empty selection when it arrives so
  // the Backend select — and the canSubmit gate that requires it — aren't
  // stuck empty; a user's explicit pick (non-empty) is preserved.
  useEffect(() => { setForkMode((m) => m || mode || ''); }, [mode]);

  const hasBackends = Array.isArray(backends) && backends.length > 0;

  const [submit, submitting] = useAsyncAction(async () => {
    const { record } = await forkSpriteRecord(source.id, {
      name: name.trim(),
      ...(id.trim() ? { id: id.trim() } : {}),
      designPrompt: designPrompt.trim(),
      ...(forkMode ? { mode: forkMode } : {}),
      initImageStrength: strength,
    }, { silent: true });
    toast.success(`Forked ${source.name} → ${record.name} — ${fromTurnaround ? 'turnaround' : 'main'} render queued`);
    onForked(record);
    onClose();
  }, { errorMessage: 'Fork failed' });

  const canSubmit = !submitting && name.trim() && designPrompt.trim() && (!hasBackends || forkMode);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      usePortal
      closeOnBackdrop={false}
      panelClassName="bg-port-card border border-port-border rounded-xl max-h-[85vh] flex flex-col"
      ariaLabel="Fork sprite"
    >
      <div className="flex items-center justify-between gap-3 p-3 border-b border-port-border">
        <h2 className="text-sm font-medium text-white flex items-center gap-1.5">
          <GitFork className="w-4 h-4" /> Fork {source?.name}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 text-gray-400 hover:text-white rounded">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <div className="flex items-start gap-3">
          {referencePath && (
            <SpritePreview
              recordId={source.id}
              path={referencePath}
              className="w-24 h-24 object-contain bg-port-bg border border-port-border rounded shrink-0"
            />
          )}
          <p className="text-xs text-gray-400">
            The new character&apos;s {fromTurnaround ? 'turnaround sheet' : 'main reference'} is generated from this
            reference image plus your prompt (image+text→image). Everything else — the rest of the
            reference set, walk cycle, atlas — starts fresh.
          </p>
        </div>

        <div>
          <label htmlFor="fork-name" className="block text-xs text-gray-400 mb-1">New name</label>
          <input
            id="fork-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
          />
        </div>

        <div>
          <label htmlFor="fork-id" className="block text-xs text-gray-400 mb-1">
            Id <span className="text-gray-600">(optional — derived from the name)</span>
          </label>
          <input
            id="fork-id"
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="derived-from-name"
            className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
          />
        </div>

        <div>
          <label htmlFor="fork-prompt" className="block text-xs text-gray-400 mb-1">Prompt — describe the change</label>
          <textarea
            id="fork-prompt"
            value={designPrompt}
            onChange={(e) => setDesignPrompt(e.target.value)}
            rows={3}
            placeholder="e.g. same character but wearing a red coat and a wide-brim hat"
            className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
          />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {hasBackends && (
            <label className="flex items-center gap-2 text-xs text-gray-400">
              Backend
              <select
                value={forkMode}
                onChange={(e) => setForkMode(e.target.value)}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
              >
                {backends.map((b) => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Fidelity to reference
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={strength}
              onChange={(e) => setStrength(Number(e.target.value))}
              className="accent-port-accent"
            />
            <span className="tabular-nums text-gray-500 w-8">{strength.toFixed(2)}</span>
          </label>
        </div>
        {!hasBackends && (
          <p className="text-xs text-port-warning">
            No image backend configured — enable Codex or Grok, or set a local Python path, in Settings → Image Gen.
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 p-3 border-t border-port-border">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancel</button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-sm"
        >
          {submitting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <GitFork className="w-3.5 h-3.5" />}
          Fork &amp; generate
        </button>
      </div>
    </Modal>
  );
}
