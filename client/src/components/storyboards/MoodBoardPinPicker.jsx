import { useCallback } from 'react';
import { Loader2, X } from 'lucide-react';
import Modal from '../ui/Modal';
import ListLoadError from '../ui/ListLoadError';
import useListResource from '../../hooks/useListResource';
import { getMoodBoard } from '../../services/api';
import { moodBoardItemAnalysisSource, moodBoardItemSrc } from '../../lib/moodBoardItemSrc';

/**
 * Pick one image pin from a mood board (a storyboard's linked board, a cast
 * member's blend faces). Only pins that are local gallery images are offered:
 * callers store a gallery filename.
 */
export default function MoodBoardPinPicker({ open, moodBoardId, onClose, onSelect }) {
  const fetchPins = useCallback(async () => {
    const board = await getMoodBoard(moodBoardId, { silent: true });
    const items = Array.isArray(board?.items) ? board.items : [];
    return items.flatMap((item) => {
      if (item?.type !== 'image') return [];
      const source = moodBoardItemAnalysisSource(item);
      return source?.filename ? [{ id: item.id, filename: source.filename, src: moodBoardItemSrc(item), caption: item.caption || '' }] : [];
    });
  }, [moodBoardId]);
  const { items: pins, state, error, retry } = useListResource(fetchPins, { enabled: open && !!moodBoardId });

  return (
    <Modal open={open} onClose={onClose} size="xl" usePortal ariaLabel="Pick a mood board pin"
      panelClassName="bg-port-card border border-port-border rounded-xl flex flex-col">
      <div className="flex items-center justify-between gap-2 p-3 border-b border-port-border">
        <h2 className="text-sm font-medium text-white">Pick from the mood board</h2>
        <button type="button" onClick={onClose} aria-label="Close"
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded text-gray-400 hover:text-white">
          <X size={16} />
        </button>
      </div>
      <div className="p-3 overflow-y-auto">
        {state === 'error' ? (
          <ListLoadError what="the mood board" error={error} onRetry={retry} />
        ) : state === 'loading' ? (
          <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-gray-500" aria-label="Loading pins" /></div>
        ) : pins.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">This mood board has no gallery image pins.</p>
        ) : (
          <ul className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
            {pins.map((pin) => (
              <li key={pin.id}>
                <button type="button" onClick={() => { onSelect(pin); onClose(); }}
                  className="block w-full aspect-square rounded overflow-hidden border border-port-border hover:border-port-accent"
                  aria-label={pin.caption || 'Mood board pin'}>
                  <img src={pin.src} alt="" loading="lazy" className="w-full h-full object-cover" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
