/**
 * Board-level prompt-from-media, composite style, and canonical poster.
 *
 * Each pin already has its own prompt-from-media action. This panel is the
 * board's: it runs that same analysis on gallery items that don't have one
 * yet, then asks for one composite still-image prompt from the stored
 * analyses (no second look at the pixels). The poster renders that prompt on
 * any enabled image service and is the board's reference image — the same
 * role a universe's base-style probe plays.
 */
import { useState } from 'react';
import { ImageIcon, X } from 'lucide-react';
import Modal from '../ui/Modal';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import MoodBoardAnalyzeSection from './MoodBoardAnalyzeSection';
import MoodBoardPromptEditor from './MoodBoardPromptEditor';
import useMoodBoardStyleActions from './useMoodBoardStyleActions';

export default function MoodBoardStylePanel({ board, onBoardChange }) {
  const [previewOpen, setPreviewOpen] = useState(false);

  const { poster, analysis, editor } = useMoodBoardStyleActions({ board, onBoardChange });
  const { jobId, handleComplete, posterSrc } = poster;

  return (
    <section aria-label="Board style" className="min-w-0 bg-port-card border border-port-border rounded-md p-3 space-y-3">
      <div className="aspect-[3/2] w-full rounded-md overflow-hidden border border-port-border bg-port-bg">
        {jobId ? (
          <MediaJobThumb jobId={jobId} onFilename={handleComplete} size="fill" label="Board poster" />
        ) : posterSrc ? (
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            aria-label="Preview board poster"
            className="block w-full h-full cursor-zoom-in"
          >
            <img src={posterSrc} alt="Board poster" className="w-full h-full object-cover" />
          </button>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-gray-600 gap-1">
            <ImageIcon className="w-6 h-6" aria-hidden="true" />
            <span className="text-[11px]">No poster yet</span>
          </div>
        )}
      </div>

      <MoodBoardAnalyzeSection {...analysis} />
      <MoodBoardPromptEditor board={board} {...editor} />
      {posterSrc ? (
        <Modal
          open={previewOpen}
          usePortal
          onClose={() => setPreviewOpen(false)}
          size="3xl"
          backdropClassName="bg-black/85"
          ariaLabelledBy="board-poster-preview-title"
          panelClassName="overflow-hidden bg-port-card border border-port-border rounded-xl shadow-2xl flex flex-col"
        >
          <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-port-border">
            <h2 id="board-poster-preview-title" className="text-sm font-semibold text-white">Board poster</h2>
            <button
              type="button"
              onClick={() => setPreviewOpen(false)}
              className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50 min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto bg-port-bg p-2 flex items-center justify-center">
            <img src={posterSrc} alt="Board poster preview" className="max-w-full max-h-full object-contain" />
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
