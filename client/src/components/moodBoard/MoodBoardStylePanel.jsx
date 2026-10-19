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
import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../../services/socket';
import { ScanEye, Sparkles, ImageIcon, ChevronDown, Cpu, X } from 'lucide-react';
import Modal from '../ui/Modal';
import ProviderModelSelector from '../ProviderModelSelector';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import useProviderModels from '../../hooks/useProviderModels';
import useVisionModelIds from '../../hooks/useVisionModelIds';
import useImageRenderSettings from '../../hooks/useImageRenderSettings';
import useSingleImageRender from '../../hooks/useSingleImageRender';
import { getMoodBoard, getMoodBoardAnalyze, startMoodBoardAnalyze, updateMoodBoard, composeMoodBoardPrompt } from '../../services/api';
import { isVisionCapableCliProvider, visionLocalModelFilter } from '../../utils/providers';
import { formatCount } from '../../utils/formatters';
import { moodBoardPosterSrc } from '../../lib/moodBoardItemSrc';
import {
  boardAnalyzePlan,
  boardPosterRenderCfg,
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

  const [aiOpen, setAiOpen] = useState(false);
  const [negativeOpen, setNegativeOpen] = useState(false);
  const negativeShown = negativeOpen || Boolean(negative);
  const [composing, setComposing] = useState(false);
  const [job, setJob] = useState(null);
  const jobRunning = job?.status === 'running';
  const busy = composing || jobRunning;
  const boardId = board?.id;
  const jobRunningRef = useRef(false);
  jobRunningRef.current = jobRunning;
  const [savingStyle, setSavingStyle] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [effort, setEffort] = useState('');
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

  const compose = async () => {
    const updated = await composeMoodBoardPrompt(board.id, {
      providerId: selectedProviderId || undefined,
      model: selectedModel || undefined,
      effort: effort || undefined,
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

  // The analyze run lives on the server, so leaving the page never cancels it.
  // Restore its state on mount and follow the push events while it runs.
  const applyJob = useCallback(async (next) => {
    if (!mountedRef.current) return;
    setJob(next);
    // Pull in the analyses saved so far, and the composed style once it ends.
    const fresh = await getMoodBoard(boardId, { silent: true }).catch(() => null);
    if (mountedRef.current && fresh) onBoardChange(fresh);
  }, [boardId, mountedRef, onBoardChange]);

  useEffect(() => {
    if (!boardId) return undefined;
    let cancelled = false;
    getMoodBoardAnalyze(boardId, { silent: true })
      .then((current) => {
        if (cancelled || !current) return;
        // A finished run from earlier is only news if it just ended.
        if (current.status === 'running') applyJob(current);
      })
      .catch(() => {});
    const onEvent = (evt) => {
      if (evt?.boardId !== boardId) return;
      const wasRunning = jobRunningRef.current;
      if (evt.status === 'running') applyJob(evt);
      else {
        applyJob(evt);
        if (wasRunning) {
          if (evt.status === 'done') toast.success('Board style composed from item analyses');
          else toast.error(evt.error || 'Board analysis failed');
        }
      }
    };
    socket.on('mood-board:analyze', onEvent);
    return () => {
      cancelled = true;
      socket.off('mood-board:analyze', onEvent);
    };
  }, [boardId, applyJob]);

  const jobProgress = jobRunning
    ? (job.phase === 'composing'
      ? 'Composing board style…'
      : job.total > 0
        ? `Analyzing ${formatCount(Math.min(job.done + 1, job.total))} of ${formatCount(job.total)}`
        : 'Preparing…')
    : '';

  const analyzeBoard = async () => {
    if (!board?.id || busy) return;
    if (!selectedProviderId) {
      toast.error('Select a vision-capable provider to analyze the board');
      return;
    }
    const started = await startMoodBoardAnalyze(board.id, {
      providerId: selectedProviderId,
      model: selectedModel || undefined,
      effort: effort || undefined,
    }, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not start the board analysis');
      return null;
    });
    if (mountedRef.current && started) setJob(started);
  };

  const composeOnly = async () => {
    if (!board?.id || busy) return;
    setComposing(true);
    await compose();
    if (mountedRef.current) setComposing(false);
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
  const analyzable = plan.analyzed + plan.pending.length;
  const progressPct = jobRunning && job.total > 0
    ? Math.round((Math.min(job.done, job.total) / job.total) * 100)
    : analyzable > 0 ? Math.round((plan.analyzed / analyzable) * 100) : 0;
  const providerName = providers.find((p) => p.id === selectedProviderId)?.name || selectedProviderId;
  const aiSummary = [providerName || 'Choose a provider', selectedModel, effort ? `${effort} effort` : null].filter(Boolean).join(' · ');

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

      {analyzable > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs text-gray-400">
            {jobRunning ? jobProgress : `${formatCount(plan.analyzed)} of ${formatCount(analyzable)} pins analyzed`}
          </p>
          <div
            role="progressbar"
            aria-label="Pins analyzed"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPct}
            className="h-1.5 rounded-full bg-port-bg overflow-hidden"
          >
            <div className="h-full bg-port-accent transition-[width]" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {showAnalyze ? (
          <button
            type="button"
            onClick={analyzeBoard}
            disabled={busy || !selectedProviderId}
            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            <ScanEye className="w-4 h-4" aria-hidden="true" />
            {jobRunning ? jobProgress : `Analyze ${formatCount(plan.pending.length)} new`}
          </button>
        ) : null}
        {showCompose ? (
          <button
            type="button"
            onClick={composeOnly}
            disabled={busy}
            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-bg border border-port-border text-gray-200 hover:text-white disabled:opacity-50 transition-colors"
          >
            Compose board style
          </button>
        ) : null}
        {!showAnalyze && !showCompose ? (
          <p className="text-xs text-gray-500">Pin an image or video to analyze this board.</p>
        ) : null}
      </div>

      {/* Provider, model and effort fold into one summary line until changed. */}
      <div>
        <button
          type="button"
          onClick={() => setAiOpen((v) => !v)}
          aria-expanded={aiOpen}
          aria-label={`Analysis AI: ${aiSummary}`}
          className="flex w-full min-h-[40px] items-center gap-2 px-2.5 rounded border border-port-border bg-port-bg text-left text-xs text-gray-300 hover:text-white"
        >
          <Cpu className="w-3.5 h-3.5 shrink-0 text-gray-400" aria-hidden="true" />
          <span className="flex-1 min-w-0 truncate">{aiSummary}</span>
          <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${aiOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
        {aiOpen ? (
          <div className="mt-2">
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onProviderChange={setSelectedProviderId}
              onModelChange={setSelectedModel}
              effort={effort}
              onEffortChange={setEffort}
              disabled={busy || providersLoading}
            />
          </div>
        ) : null}
      </div>
      {providers.length === 0 && !providersLoading ? (
        <p className="text-xs text-port-warning">No vision-capable provider is enabled. Add one under Settings → Providers to analyze items. Composing from analyses you already have still works.</p>
      ) : null}
      {plan.skipped > 0 ? (
        <p className="text-[11px] text-gray-500">
          {formatCount(plan.skipped)} pin{plan.skipped === 1 ? '' : 's'} couldn’t be imported from {plan.skipped === 1 ? 'its' : 'their'} source URL and can’t be analyzed yet.
        </p>
      ) : null}

      <div>
        <label htmlFor="board-style-prompt" className="block text-xs text-gray-400 mb-1">Style prompt</label>
        <textarea
          id="board-style-prompt"
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
            disabled={Boolean(jobId) || rendererOptions.length === 0}
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
      {posterSrc ? (
        <Modal
          open={previewOpen}
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
