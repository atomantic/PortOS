/**
 * "New Sprite" for the Sprite Manager header — a small modal that creates an
 * empty record of the picked kind (character / props / ambient …). Only
 * characters carry the reference/walk/publish workflows, which the kind hint
 * spells out before the record exists. The created record bubbles up so the page
 * can refresh the library and navigate into it.
 *
 * Open/closed is controlled by the page so the library's empty state can offer
 * "create your first sprite" as its call to action.
 */

import { useState } from 'react';
import { Plus, X, RefreshCw } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { createSpriteRecord } from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { NEW_SPRITE_KINDS } from '../../lib/spriteRecordGroups.js';

export default function NewSpritePanel({ onCreated, open, onOpenChange }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [kind, setKind] = useState('character');

  const [create, creating] = useAsyncAction(async () => {
    const record = await createSpriteRecord({
      name: name.trim(),
      kind,
      ...(id.trim() ? { id: id.trim() } : {}),
    }, { silent: true });
    onOpenChange(false);
    setName('');
    setId('');
    setKind('character');
    onCreated(record);
  }, { errorMessage: 'Failed to create sprite' });

  return (
    <>
      <button
        onClick={() => onOpenChange(true)}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border hover:border-port-accent text-gray-300 rounded text-sm"
      >
        <Plus className="w-4 h-4" /> New Sprite
      </button>
      <Modal open={open} onClose={() => onOpenChange(false)} size="sm" ariaLabel="New sprite" closeOnBackdrop={false}>
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">New sprite</h3>
            <button onClick={() => onOpenChange(false)} aria-label="Close new sprite panel" className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div>
            <label htmlFor="sprite-new-kind" className="block text-xs text-gray-400 mb-1">Kind</label>
            <select
              id="sprite-new-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
            >
              {NEW_SPRITE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
            {kind !== 'character' && (
              <p className="mt-1 text-xs text-gray-600">
                Reference, walk, and publish workflows are character-only — a {kind} holds imported/uploaded assets.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="sprite-new-name" className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              id="sprite-new-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create(); }}
              placeholder="Trail Hand"
              className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
            />
          </div>
          <div>
            <label htmlFor="sprite-new-id" className="block text-xs text-gray-400 mb-1">
              Id <span className="text-gray-600">(optional — derived from the name; required for names with no a–z/0–9 characters)</span>
            </label>
            <input
              id="sprite-new-id"
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="trail-hand"
              className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
            />
          </div>
          <button
            onClick={create}
            disabled={creating || !name.trim()}
            className="flex items-center gap-2 px-3 py-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-sm"
          >
            {creating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Create
          </button>
        </div>
      </Modal>
    </>
  );
}
