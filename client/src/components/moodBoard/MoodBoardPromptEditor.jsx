import { useState } from 'react';
import { Sparkles } from 'lucide-react';

export default function MoodBoardPromptEditor({
  board,
  busy,
  prompt,
  setPrompt,
  negative,
  setNegative,
  savedNegative,
  styleDirty,
  saveStyle,
  savingStyle,
  resolvedMode,
  setRendererMode,
  jobId,
  rendererOptions,
  renderPoster,
  canRender,
  savedPrompt,
  posterSrc,
}) {
  const [negativeOpen, setNegativeOpen] = useState(false);
  // Stays shown while a saved negative prompt is being cleared.
  const negativeShown = negativeOpen || Boolean(negative) || Boolean(savedNegative);

  return (
    <>
      <div>
        <label htmlFor="board-style-prompt" className="block text-xs text-gray-400 mb-1">Style prompt</label>
        <textarea
          id="board-style-prompt"
          disabled={busy}
          value={prompt}
          rows={5}
          maxLength={8000}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Compose a style from the item analyses, or write one."
          className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none resize-y"
        />
      </div>
      {negativeShown ? (
        <div>
          <label htmlFor="board-style-negative" className="block text-xs text-gray-400 mb-1">Negative prompt (optional)</label>
          <textarea
            id="board-style-negative"
            disabled={busy}
            value={negative}
            rows={2}
            maxLength={8000}
            onChange={(e) => setNegative(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none resize-y"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setNegativeOpen(true)}
          className="min-h-[36px] text-xs text-port-accent hover:underline"
        >
          + Negative prompt (optional)
        </button>
      )}
      {board?.style?.rationale ? (
        <p className="text-xs text-gray-400">{board.style.rationale}</p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        {styleDirty ? (
          <button
            type="button"
            onClick={saveStyle}
            disabled={savingStyle || busy}
            className="min-h-[40px] px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            {savingStyle ? 'Saving…' : 'Save style'}
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <label htmlFor="board-poster-renderer" className="block text-xs text-gray-400 mb-1">Poster renderer</label>
          <select
            id="board-poster-renderer"
            value={resolvedMode}
            onChange={(e) => setRendererMode(e.target.value)}
            disabled={busy || Boolean(jobId) || rendererOptions.length === 0}
            className="w-full min-h-[40px] bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none"
          >
            {rendererOptions.length === 0 ? <option value="">Loading renderers…</option> : null}
            {rendererOptions.map((backend) => (
              <option key={backend.id} value={backend.id}>{backend.label}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={renderPoster}
          disabled={!canRender || Boolean(jobId)}
          title={styleDirty ? 'Save the board style first' : (savedPrompt.trim() ? 'Render the poster on the selected image service' : 'Compose a board style first')}
          className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-success text-white hover:bg-port-success/80 disabled:opacity-50 transition-colors"
        >
          <Sparkles className="w-4 h-4" aria-hidden="true" />
          {posterSrc ? 'Regenerate poster' : 'Generate poster'}
        </button>
      </div>
    </>
  );
}
