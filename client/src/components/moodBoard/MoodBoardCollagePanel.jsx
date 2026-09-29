import { useState } from 'react';
import { LayoutGrid, Download } from 'lucide-react';
import toast from '../ui/Toast';
import { composeMoodBoardCollage } from '../../services/api';
import { moodBoardCollageSrc } from '../../lib/moodBoardItemSrc';

/**
 * Board-level "Collage" control: compiles every image (plus sampled video
 * frames) into one near-square grid image saved to the gallery.
 */
export default function MoodBoardCollagePanel({ board, onBoardChange }) {
  const items = Array.isArray(board?.items) ? board.items : [];
  const hasVideo = items.some((it) => it.type === 'video');
  const hasVisual = items.some((it) => it.type === 'image' || it.type === 'video');
  const [framesPerVideo, setFramesPerVideo] = useState(3);
  const [addFramesToBoard, setAddFramesToBoard] = useState(false);
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState(null);

  if (!hasVisual) return null;
  const shownSrc = result?.url || moodBoardCollageSrc(board);

  const handleBuild = async () => {
    setBuilding(true);
    const res = await composeMoodBoardCollage(
      board.id,
      { framesPerVideo, addFramesToBoard: hasVideo && addFramesToBoard },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Could not build collage'); return null; });
    setBuilding(false);
    if (!res) return;
    setResult(res);
    if (res.board) onBoardChange?.(res.board);
    toast.success(`Collage built: ${res.cols}×${res.rows} grid, ${res.cells} image${res.cells === 1 ? '' : 's'}`);
  };

  return (
    <div className="bg-port-card border border-port-border rounded-md p-3 space-y-3" aria-label="Collage">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="text-sm font-medium text-white flex items-center gap-1.5 mr-2 self-center">
          <LayoutGrid className="w-4 h-4" aria-hidden="true" /> Collage
        </h2>
        {hasVideo ? (
          <>
            <div>
              <label htmlFor="collage-frames" className="block text-xs text-gray-400 mb-1">Frames per video</label>
              <input
                id="collage-frames"
                type="number"
                min={1}
                max={24}
                value={framesPerVideo}
                onChange={(e) => setFramesPerVideo(Math.max(1, Math.min(24, Math.floor(Number(e.target.value)) || 1)))}
                className="w-20 bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none"
              />
            </div>
            <label htmlFor="collage-add-frames" className="flex items-center gap-2 text-sm text-gray-300 min-h-[40px]">
              <input
                id="collage-add-frames"
                type="checkbox"
                checked={addFramesToBoard}
                onChange={(e) => setAddFramesToBoard(e.target.checked)}
              />
              Also add frames to the board
            </label>
          </>
        ) : null}
        <button
          type="button"
          onClick={handleBuild}
          disabled={building}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
        >
          <LayoutGrid className={`w-4 h-4 ${building ? 'animate-pulse' : ''}`} aria-hidden="true" />
          {building ? 'Building…' : 'Build collage'}
        </button>
      </div>
      {shownSrc ? (
        <div className="space-y-2">
          <img src={shownSrc} alt="Board collage" className="w-full max-w-md rounded border border-port-border" />
          <div className="flex items-center gap-3 text-xs text-gray-400">
            {result ? <span>{result.width}×{result.height}px · {result.cols}×{result.rows} grid{result.skipped ? ` · ${result.skipped} skipped` : ''}</span> : null}
            <a href={shownSrc} download className="flex items-center gap-1 text-port-accent hover:underline">
              <Download className="w-3.5 h-3.5" aria-hidden="true" /> Download
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
