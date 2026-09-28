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
import { useCallback, useRef, useState } from 'react';
import { ScanEye, Sparkles, ImageIcon } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import useProviderModels from '../../hooks/useProviderModels';
import useVisionModelIds from '../../hooks/useVisionModelIds';
import useImageRenderSettings from '../../hooks/useImageRenderSettings';
import useSingleImageRender from '../../hooks/useSingleImageRender';
import { promptFromMedia, updateMoodBoard, updateMoodBoardItem, composeMoodBoardPrompt } from '../../services/api';
import { isVisionCapableCliProvider, visionLocalModelFilter } from '../../utils/providers';
import { formatCount } from '../../utils/formatters';
import { moodBoardItemAnalysisSource, moodBoardPosterSrc } from '../../lib/moodBoardItemSrc';
import {
  boardAnalyzePlan,
  boardPosterRenderCfg,
  moodBoardAnalysisFromResult,
  posterStyleKey,
} from '../../lib/moodBoardAnalysis';
import { modeLabel } from '../../lib/imageGenBackends';

const visionProviderFilter = (p) => p.enabled && (p.type === 'api' || isVisionCapableCliProvider(p));

export default function MoodBoardStylePanel({ board, onBoardChange }) {
  const mountedRef = useMounted();
  const items = Array.isArray(board?.items) ? board.items : [];
  const plan = boardAnalyzePlan(items);
  const posterSrc = moodBoardPosterSrc(board);
  const savedPrompt = board?.style?.prompt || '';
  const savedNegative = board?.style?.negativePrompt || '';

  const styleIdentity = `${board?.style?.composedAt || ''}\0${savedPrompt}\0${savedNegative}`;
  const [seenStyle, setSeenStyle] = useState(styleIdentity);
  const [prompt, setPrompt] = useState(savedPrompt);
  const [negative, setNegative] = useState(savedNegative);
  if (seenStyle !== styleIdentity) {
    setSeenStyle(styleIdentity);
    setPrompt(savedPrompt);
    setNegative(savedNegative);
  }

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [savingStyle, setSavingStyle] = useState(false);
  const [rendererMode, setRendererMode] = useState('');
  const capturedKeyRef = useRef(null);

  const { idsByProvider: visionIds } = useVisionModelIds(true);
  const modelFilter = useCallback(
    (id, provider) => visionLocalModelFilter(id, provider, visionIds),
    [visionIds],
  );
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
  } = useProviderModels({
    filter: visionProviderFilter,
    silent: true,
    withEffort: true,
    modelFilter,
  });

  const { imageCfg, backends } = useImageRenderSettings({ includeExternal: true });
  const resolvedMode = rendererMode || imageCfg?.mode || '';
  const rendererOptions = backends.some((b) => b.id === resolvedMode) || !resolvedMode
    ? backends
    : [{ id: resolvedMode, label: modeLabel(resolvedMode) }, ...backends];

  const styleDirty = prompt.trim() !== savedPrompt.trim()
    || negative.trim() !== savedNegative.trim();
  const canRender = Boolean(board?.id) && Boolean(savedPrompt.trim()) && !styleDirty && !busy;

  const onPosterComplete = async (filename) => {
    if (!board?.id || !filename) return;
    const captured = capturedKeyRef.current;
    capturedKeyRef.current = null;
    if (captured == null || captured !== posterStyleKey(board.style)) {
      toast.error('Board style changed while the poster rendered — generate it again');
      return;
    }
    const updated = await updateMoodBoard(board.id, { posterImageRef: filename }, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) {
      toast.error('Poster rendered but could not be saved on the board');
      return;
    }
    onBoardChange(updated);
    toast.success('Board poster saved');
  };

  const { jobId, render: queueRender, handleComplete } = useSingleImageRender({
    buildPrompt: () => {
      const text = (board?.style?.prompt || '').trim();
      if (!text) return null;
      return { prompt: text, negativePrompt: (board?.style?.negativePrompt || '').trim() };
    },
    onComplete: onPosterComplete,
    onError: (err) => toast.error(err?.message || 'Poster render failed'),
    scopeId: board?.id,
  });

  const replaceItem = (item) => {
    onBoardChange((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === item.id ? item : it)) }
      : prev));
  };

  const compose = async () => {
    const updated = await composeMoodBoardPrompt(board.id, {
      providerId: selectedProviderId || undefined,
      model: selectedModel || undefined,
    }, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(err?.message || 'Could not compose a board style from the item analyses');
      return null;
    });
    if (!mountedRef.current || !updated) return null;
    if (!updated.style?.prompt) {
      toast.error('Could not compose a board style from the item analyses');
      return null;
    }
    onBoardChange(updated);
    toast.success('Board style composed from item analyses');
    return updated;
  };

  const analyzeBoard = async () => {
    if (!board?.id || busy) return;
    if (!selectedProviderId) {
      toast.error('Select a vision-capable provider to analyze the board');
      return;
    }
    setBusy(true);
    let failures = 0;
    const pending = plan.pending;
    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      const source = moodBoardItemAnalysisSource(item);
      if (!source) continue;
      setProgress(`Analyzing ${formatCount(i + 1)} of ${formatCount(pending.length)}`);
      const data = await promptFromMedia({
        sourceKind: source.kind === 'video' ? 'video' : 'image',
        filename: source.filename,
        targets: source.kind === 'video' ? ['image', 'video'] : ['image'],
        providerId: selectedProviderId,
        model: selectedModel || undefined,
      }, { silent: true }).catch(() => null);
      if (!mountedRef.current) return;
      const analysis = moodBoardAnalysisFromResult(item, data);
      if (!analysis) {
        failures += 1;
        continue;
      }
      const saved = await updateMoodBoardItem(board.id, item.id, { analysis }, { silent: true }).catch(() => null);
      if (!mountedRef.current) return;
      if (!saved) {
        failures += 1;
        continue;
      }
      replaceItem(saved);
    }
    setProgress('');
    const analyzedNow = plan.analyzed + (pending.length - failures);
    if (analyzedNow < 1) {
      setBusy(false);
      toast.error('No item could be analyzed, so the board style was not composed');
      return;
    }
    if (failures > 0) {
      toast.error(`${formatCount(failures)} item${failures === 1 ? '' : 's'} could not be analyzed`);
    }
    await compose();
    if (mountedRef.current) setBusy(false);
  };

  const composeOnly = async () => {
    if (!board?.id || busy) return;
    setBusy(true);
    await compose();
    if (mountedRef.current) setBusy(false);
  };

  const saveStyle = async () => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt) {
      toast.error('The board style prompt can’t be empty');
      return;
    }
    setSavingStyle(true);
    const style = {
      prompt: nextPrompt,
      negativePrompt: negative.trim() || null,
      rationale: board.style?.rationale || null,
      analyzedItemCount: board.style?.analyzedItemCount || 0,
      providerId: board.style?.providerId || null,
      model: board.style?.model || null,
      composedAt: board.style?.composedAt || new Date().toISOString(),
    };
    const updated = await updateMoodBoard(board.id, { style }, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setSavingStyle(false);
    if (!updated) {
      toast.error('Failed to save the board style');
      return;
    }
    onBoardChange(updated);
    toast.success('Board style saved');
  };

  const renderPoster = async () => {
    if (styleDirty) {
      toast.error('Save the board style before generating the poster');
      return;
    }
    if (!savedPrompt.trim()) {
      toast.error('Compose a board style before generating the poster');
      return;
    }
    const key = posterStyleKey(board.style);
    const queued = await queueRender(boardPosterRenderCfg(imageCfg, resolvedMode));
    if (queued) capturedKeyRef.current = key;
  };

  const showAnalyze = plan.pending.length > 0;
  const showCompose = plan.analyzed > 0;

  return (
    <section className="bg-port-card border border-port-border rounded-md p-3">
      <div className="flex items-center gap-2 mb-2">
        <ScanEye className="w-4 h-4 text-port-accent" aria-hidden="true" />
        <h2 className="text-sm font-medium text-white">Board style</h2>
        <span className="text-[11px] text-gray-500 truncate" title="Prompt from media for each gallery item, then one composite style from those prompts. The poster is this board’s canonical reference image.">
          Analyze pins → composite style → poster
        </span>
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="w-full sm:w-36 shrink-0">
          <div className="aspect-[3/2] w-full rounded-md overflow-hidden border border-port-border bg-port-bg">
            {jobId ? (
              <MediaJobThumb jobId={jobId} onFilename={handleComplete} size="fill" label="Board poster" />
            ) : posterSrc ? (
              <img src={posterSrc} alt="Board poster" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-gray-600 gap-1">
                <ImageIcon className="w-6 h-6" aria-hidden="true" />
                <span className="text-[11px]">No poster yet</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={setSelectedProviderId}
            onModelChange={setSelectedModel}
            disabled={busy || providersLoading}
            layout="row"
          />
          {providers.length === 0 && !providersLoading ? (
            <p className="text-xs text-port-warning">No vision-capable provider is enabled. Add one under Settings → Providers to analyze items. Composing from analyses you already have still works.</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {showAnalyze ? (
              <button
                type="button"
                onClick={analyzeBoard}
                disabled={busy || !selectedProviderId}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
              >
                <ScanEye className="w-4 h-4" aria-hidden="true" />
                {busy && progress ? progress : 'Analyze board'}
              </button>
            ) : null}
            {showCompose ? (
              <button
                type="button"
                onClick={composeOnly}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-bg border border-port-border text-gray-200 hover:text-white disabled:opacity-50 transition-colors"
              >
                Compose board style
              </button>
            ) : null}
            {!showAnalyze && !showCompose ? (
              <p className="text-xs text-gray-500">Pin an image or video to analyze this board.</p>
            ) : null}
          </div>
          {plan.skipped > 0 ? (
            <p className="text-[11px] text-gray-500">
              {formatCount(plan.skipped)} pin{plan.skipped === 1 ? '' : 's'} couldn’t be imported from {plan.skipped === 1 ? 'its' : 'their'} source URL and can’t be analyzed yet.
            </p>
          ) : null}
          <details className="group" open={!savedPrompt}>
            <summary className="cursor-pointer text-xs text-gray-400 hover:text-white select-none">
              Style prompt{savedPrompt ? `: ${savedPrompt.slice(0, 90)}${savedPrompt.length > 90 ? '…' : ''}` : ''}
            </summary>
            <div className="space-y-2 mt-2">
              <div>
                <label htmlFor="board-style-prompt" className="block text-xs text-gray-400 mb-1">Style prompt</label>
                <textarea
                  id="board-style-prompt"
                  value={prompt}
                  rows={4}
                  maxLength={8000}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Compose a style from the item analyses, or write one."
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none resize-y"
                />
              </div>
              <div>
                <label htmlFor="board-style-negative" className="block text-xs text-gray-400 mb-1">Negative prompt</label>
                <textarea
                  id="board-style-negative"
                  value={negative}
                  rows={2}
                  maxLength={8000}
                  onChange={(e) => setNegative(e.target.value)}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none resize-y"
                />
              </div>
            </div>
          </details>
          {board?.style?.rationale ? (
            <p className="text-xs text-gray-400">{board.style.rationale}</p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0">
              <label htmlFor="board-poster-renderer" className="block text-xs text-gray-400 mb-1">Image renderer</label>
              <select
                id="board-poster-renderer"
                value={resolvedMode}
                onChange={(e) => setRendererMode(e.target.value)}
                disabled={Boolean(jobId) || rendererOptions.length === 0}
                className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none max-w-full"
              >
                {rendererOptions.length === 0 ? <option value="">Loading renderers…</option> : null}
                {rendererOptions.map((backend) => (
                  <option key={backend.id} value={backend.id}>{backend.label}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={saveStyle}
              disabled={!styleDirty || savingStyle || busy}
              className="px-3 py-1.5 text-sm rounded bg-port-bg border border-port-border text-gray-200 hover:text-white disabled:opacity-50 transition-colors"
            >
              {savingStyle ? 'Saving…' : 'Save style'}
            </button>
            <button
              type="button"
              onClick={renderPoster}
              disabled={!canRender || Boolean(jobId)}
              title={styleDirty ? 'Save the board style first' : (savedPrompt.trim() ? 'Render the poster on the selected image service' : 'Compose a board style first')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-success text-white hover:bg-port-success/80 disabled:opacity-50 transition-colors"
            >
              <Sparkles className="w-4 h-4" aria-hidden="true" />
              {posterSrc ? 'Regenerate poster' : 'Generate poster'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
