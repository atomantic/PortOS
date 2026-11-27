import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../../services/socket';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import useProviderModels from '../../hooks/useProviderModels';
import useVisionModelIds from '../../hooks/useVisionModelIds';
import useImageRenderSettings from '../../hooks/useImageRenderSettings';
import useSingleImageRender from '../../hooks/useSingleImageRender';
import { getMoodBoard, getMoodBoardAnalyze, startMoodBoardAnalyze, updateMoodBoard, composeMoodBoardPrompt } from '../../services/apiMoodBoard.js';
import { isVisionCapableCodexTuiProvider, isVisionCapableCliProvider, visionLocalModelFilter } from '../../utils/providers';
import { moodBoardPosterSrc } from '../../lib/moodBoardItemSrc';
import { boardAnalyzePlan, boardPosterRenderCfg, posterStyleKey } from '../../lib/moodBoardAnalysis';
import { modeLabel, IMAGE_GEN_MODE } from '../../lib/imageGenBackends';
import { QUEUEABLE_IMAGE_MODES } from '../../../../server/lib/generationModes.js';

const visionProviderFilter = (p) => p.enabled && (p.type === 'api' || isVisionCapableCliProvider(p) || isVisionCapableCodexTuiProvider(p));

function isBoardStyleComplete({ board, items, plan, posterSrc, savedPrompt, styleDirty }) {
  // Existing composition metadata lets a newly added or re-analyzed pin make
  // the shortcut available again without hiding the individual redo actions.
  const composedAt = Date.parse(board?.style?.composedAt || '');
  const hasNewerInput = items.some((item) =>
    Date.parse(item.createdAt || '') > composedAt
    || Date.parse(item.analysis?.analyzedAt || '') > composedAt);
  return Boolean(posterSrc && savedPrompt.trim()) && !styleDirty
    && plan.pending.length === 0 && plan.skipped === 0 && plan.analyzed >= board?.style?.analyzedItemCount
    && !hasNewerInput;
}

export default function useMoodBoardStyleActions({ board, onBoardChange }) {
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

  const [composing, setComposing] = useState(false);
  const boardId = board?.id;
  const [startRequest, setStartRequest] = useState(null);
  const startingRef = useRef(null);
  const starting = Boolean(boardId && startRequest?.boardId === boardId);
  const [jobSnapshot, setJob] = useState(null);
  const job = jobSnapshot?.boardId === boardId ? jobSnapshot : null;
  const jobRunning = job?.status === 'running';
  const busy = composing || jobRunning || starting;
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  const refreshRef = useRef(0);
  const jobRunningRef = useRef(false);
  jobRunningRef.current = jobRunning;
  const [savingStyle, setSavingStyle] = useState(false);
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
    error: providersError,
    retry: retryProviders,
  } = useProviderModels({
    filter: visionProviderFilter,
    silent: true,
    withEffort: true,
    modelFilter,
  });

  const { imageCfg, backends } = useImageRenderSettings({ includeExternal: true });
  const resolvedMode = rendererMode || imageCfg?.mode || '';
  const canCompleteRender = QUEUEABLE_IMAGE_MODES.includes(resolvedMode);
  const rendererOptions = backends.some((b) => b.id === resolvedMode) || !resolvedMode
    ? backends
    : [{ id: resolvedMode, label: modeLabel(resolvedMode) }, ...backends];

  const styleDirty = prompt.trim() !== savedPrompt.trim()
    || negative.trim() !== savedNegative.trim();
  const canRender = Boolean(board?.id) && Boolean(savedPrompt.trim()) && !styleDirty && !busy;
  const complete = isBoardStyleComplete({ board, items, plan, posterSrc, savedPrompt, styleDirty });
  const showMakeComplete = !complete || (jobRunning && job.makeComplete);

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
    toast.success('Style prompt updated from saved pin analyses');
    return updated;
  };

  // The analyze run lives on the server, so leaving the page never cancels it.
  // Restore its state on mount and follow the push events while it runs.
  const applyJob = useCallback(async (next) => {
    if (!mountedRef.current || boardIdRef.current !== boardId) return;
    const refresh = ++refreshRef.current;
    setJob(next);
    // Pull in the analyses saved so far, and the composed style once it ends.
    const fresh = await getMoodBoard(boardId, { silent: true }).catch(() => null);
    if (mountedRef.current && boardIdRef.current === boardId && refresh === refreshRef.current && fresh) onBoardChange(fresh);
  }, [boardId, mountedRef, onBoardChange]);

  useEffect(() => {
    if (!boardId) return undefined;
    let cancelled = false;
    const restore = () => {
      const refresh = refreshRef.current;
      getMoodBoardAnalyze(boardId, { silent: true })
        .then((current) => {
          if (cancelled || refresh !== refreshRef.current) return;
          if (current || jobRunningRef.current) applyJob(current);
        })
        .catch(() => {});
    };
    restore();
    const onEvent = (evt) => {
      if (evt?.boardId !== boardId) return;
      const wasRunning = jobRunningRef.current;
      if (evt.status === 'running') applyJob(evt);
      else {
        applyJob(evt);
        if (wasRunning) {
          if (evt.status === 'done') toast.success(evt.makeComplete ? 'Board complete: style prompt and main image saved' : 'Style prompt updated from saved pin analyses');
          else toast.error(evt.error || 'Board analysis failed');
        }
      }
    };
    socket.on('mood-board:analyze', onEvent);
    socket.on('connect', restore);
    return () => {
      cancelled = true;
      socket.off('mood-board:analyze', onEvent);
      socket.off('connect', restore);
    };
  }, [boardId, applyJob]);

  const analyzeBoard = async (makeComplete = false) => {
    if (!boardId || busy || startingRef.current?.boardId === boardId) return;
    if (!selectedProviderId) {
      toast.error('Select a vision-capable provider to analyze the board');
      return;
    }
    const request = { boardId };
    const refresh = refreshRef.current;
    startingRef.current = request;
    setStartRequest(request);
    const started = await startMoodBoardAnalyze(boardId, {
      ...(makeComplete ? { render: { mode: resolvedMode, ...(resolvedMode === IMAGE_GEN_MODE.LOCAL && imageCfg?.modelId ? { model: imageCfg.modelId } : {}) } } : {}),
      providerId: selectedProviderId,
      model: selectedModel || undefined,
      effort: effort || undefined,
    }, { silent: true }).catch((err) => {
      if (mountedRef.current && boardIdRef.current === boardId) toast.error(err?.message || 'Could not start the board analysis');
      return null;
    });
    if (startingRef.current === request) startingRef.current = null;
    if (mountedRef.current) {
      setStartRequest((current) => current === request ? null : current);
      // Push events and restored state received since kickoff are newer than this response.
      if (started && boardIdRef.current === boardId && refresh === refreshRef.current) setJob(started);
    }
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

  return {
    poster: { jobId, handleComplete, posterSrc },
    analysis: {
      plan, job, jobRunning, busy, composing, showMakeComplete, jobId, styleDirty,
      canCompleteRender, analyzeBoard, composeOnly, providers, selectedProviderId, selectedModel,
      availableModels, setSelectedProviderId, setSelectedModel, effort, setEffort,
      providersLoading, providersError, retryProviders,
    },
    editor: {
      busy, prompt, setPrompt, negative, setNegative, savedNegative, styleDirty, saveStyle,
      savingStyle, resolvedMode, setRendererMode, jobId, rendererOptions, renderPoster,
      canRender, savedPrompt, posterSrc,
    },
  };
}
