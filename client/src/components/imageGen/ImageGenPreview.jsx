import { Download, Film, Image as ImageIcon } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';

export default function ImageGenPreview({ generation, onSendToVideo }) {
  const {
    generating,
    statusMsg,
    progress,
    progressPct,
    stage,
    stageLabel,
    result,
  } = generation;

  return (
    <div className="min-w-0 bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Preview</h2>
        {result && !generating && (
          <a href={result.path} download className="flex items-center gap-1 text-xs text-port-accent hover:underline">
            <Download className="w-3 h-3" /> Download
          </a>
        )}
      </div>

      <div className="aspect-square max-w-[360px] mx-auto bg-port-bg border border-port-border rounded-lg overflow-hidden flex items-center justify-center relative">
        {progress?.currentImage ? (
          <img src={`data:image/png;base64,${progress.currentImage}`} alt="Diffusing..." decoding="async" className="w-full h-full object-contain" />
        ) : result ? (
          <img src={result.path} alt={result.prompt} decoding="async" className="w-full h-full object-contain" />
        ) : generating ? (
          <div className="text-gray-500 text-sm flex flex-col items-center gap-2 px-4 text-center">
            <BrailleSpinner />
            <span className="font-medium text-gray-300">
              {stageLabel || statusMsg || 'Starting diffusion…'}
            </span>
            {stage?.detail && (
              <span className="text-[10px] text-gray-500 truncate max-w-[280px]">{stage.detail}</span>
            )}
          </div>
        ) : (
          <div className="text-gray-600 text-xs flex flex-col items-center gap-1.5">
            <ImageIcon className="w-8 h-8" />
            <span>Generated image will appear here</span>
          </div>
        )}

        {generating && progressPct != null && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
            <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        )}
      </div>

      {generating && progress?.totalSteps != null && (
        <div className="flex items-center justify-center gap-2 text-[11px] text-gray-400 tabular-nums">
          <span>step {progress.step ?? 0}/{progress.totalSteps}</span>
          {progressPct != null && <span className="text-gray-600">·</span>}
          {progressPct != null && <span>{progressPct}%</span>}
        </div>
      )}

      {result && !generating && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <span className="truncate flex-1">{result.filename}</span>
          <span>{result.width}×{result.height}</span>
          {result.seed != null && <span>seed {result.seed}</span>}
          <button
            type="button"
            onClick={() => onSendToVideo(result)}
            className="flex items-center gap-1 px-2 py-1 bg-port-success/20 hover:bg-port-success/40 text-port-success rounded text-xs"
          >
            <Film className="w-3 h-3" /> Send to Video
          </button>
        </div>
      )}
    </div>
  );
}
