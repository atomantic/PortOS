import { useEffect, useMemo, useState } from 'react';
import { Check, Music2, Plus, Search, X } from 'lucide-react';
import Modal from '../ui/Modal';
import { formatTimecode } from '../../utils/formatters';

// Searchable, batch-oriented picker for adding existing library tracks to an
// album. The parent owns persistence and ordering; this component only returns
// the selected records in their current library order.
export default function AlbumTrackPicker({ open, tracks = [], onClose, onAdd }) {
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIds(new Set());
  }, [open]);

  const filteredTracks = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return tracks;
    return tracks.filter((track) => {
      const searchable = `${track.title || ''} ${track.artist || ''}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }, [tracks, query]);

  const toggleTrack = (trackId) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  };

  const handleAdd = () => {
    const selectedTracks = tracks.filter((track) => selectedIds.has(track.id));
    if (selectedTracks.length === 0) return;
    onAdd(selectedTracks);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      panelClassName="bg-port-card border border-port-border rounded-xl flex flex-col"
      ariaLabelledBy="album-track-picker-title"
    >
      <div className="flex items-center justify-between p-4 border-b border-port-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <Music2 className="w-5 h-5 text-port-accent" aria-hidden="true" />
          <h2 id="album-track-picker-title" className="text-lg font-bold text-white">Add tracks</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close track picker" className="p-2 text-gray-500 hover:text-white rounded min-h-[44px] min-w-[44px] flex items-center justify-center">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="p-4 border-b border-port-border flex-shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <label htmlFor="album-track-picker-search" className="sr-only">Search tracks by title or artist</label>
          <input
            id="album-track-picker-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by title or artist…"
            autoFocus
            className="w-full pl-9 pr-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 min-h-0">
        {filteredTracks.length === 0 ? (
          <p className="text-sm text-gray-400">No matching tracks.</p>
        ) : (
          <ul className="space-y-2">
            {filteredTracks.map((track) => {
              const checked = selectedIds.has(track.id);
              return (
                <li key={track.id}>
                  <label className={`flex items-center gap-3 w-full p-3 rounded border bg-port-bg/40 cursor-pointer transition-colors ${checked ? 'border-port-accent' : 'border-port-border hover:border-gray-500'}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTrack(track.id)}
                      className="accent-port-accent"
                      aria-label={`Select ${track.title || 'untitled track'}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-white truncate">{track.title || '(untitled)'}</span>
                      {track.artist ? <span className="block text-xs text-gray-400 truncate">{track.artist}</span> : null}
                    </span>
                    {track.durationSec ? <span className="text-xs text-gray-500">{formatTimecode(track.durationSec)}</span> : null}
                    {checked ? <Check size={16} className="text-port-accent shrink-0" aria-hidden="true" /> : null}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="p-4 border-t border-port-border flex items-center justify-between gap-3 flex-shrink-0">
        <span className="text-xs text-gray-400">{selectedIds.size} selected</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded text-sm text-gray-400 hover:text-white">Cancel</button>
          <button type="button" onClick={handleAdd} disabled={selectedIds.size === 0} className="inline-flex items-center gap-2 px-3 py-2 rounded bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium">
            <Plus size={14} aria-hidden="true" /> Add selected
          </button>
        </div>
      </div>
    </Modal>
  );
}
