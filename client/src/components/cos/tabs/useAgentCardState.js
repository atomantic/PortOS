import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCosAgent, getCosAgentPrompt, getCosAgentStats } from '../../../services/apiAgents.js';
import { copyToClipboard } from '../../../lib/clipboard';
import { estimateCosDuration } from '../../../lib/cosDurationEstimate';
import { useSocketResource } from '../../../hooks/useSocketResource';
import useStickToBottom from './useStickToBottom';
import { useTimeTick } from '../../../hooks/useTimeTick';
import { formatCount, formatDurationMs } from '../../../utils/formatters';

const STATS_EVENTS = ['cos:agent:updated', 'cos:agent:output'];

// `GET /api/cos/agents/:id` hydrates a completed agent's transcript as a capped
// TAIL rather than the whole output.txt (#3498), so keep the truncation marker
// alongside the lines — the reader has to know the log was clipped.
function toTranscript(data) {
  return {
    lines: data?.output || [],
    truncated: Boolean(data?.outputTruncated),
    totalBytes: data?.outputTotalBytes || 0
  };
}

export function useAgentCardState({ agent, completed, inactive, initiallyExpanded, liveOutput, remote, durations }) {
  const transcript = useTranscript({ agent, completed, inactive, initiallyExpanded, liveOutput, remote });
  const runtime = useRuntime({ agent, inactive, expanded: transcript.expanded, remote, durations });
  const prompt = usePrompt(agent.id);
  return { transcript, runtime, prompt };
}

function useTranscript({ agent, completed, inactive, initiallyExpanded, liveOutput, remote }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [fullOutput, setFullOutput] = useState(null);
  const [fullMetadata, setFullMetadata] = useState(null);
  const [loadingOutput, setLoadingOutput] = useState(false);
  // A failed transcript read. History rows carry no `output`, so caching an
  // empty transcript on failure would read as "No output captured" for good.
  const [outputError, setOutputError] = useState(null);
  // Pipeline stage output: track which stage tab is active and cached outputs per stage agentId
  const [activeStageTab, setActiveStageTab] = useState(null);
  const [stageOutputs, setStageOutputs] = useState({});
  // Per-stage in-flight reads: a shared "one stage loading" flag swallowed a
  // Retry on one stage while another stage's read was still pending.
  const [loadingStageIds, setLoadingStageIds] = useState(() => new Set());
  const stageInFlightRef = useRef(new Set());
  const [stageErrors, setStageErrors] = useState({});

  // Supersession token for the full-output read below.
  const outputRequestRef = useRef(0);

  // Fetch full output when expanded for completed agents (skip for remote)
  useEffect(() => {
    if (!(expanded && inactive && !fullOutput && !loadingOutput && !outputError && !remote)) return;
    // A request-generation ref, not a `let active` flag: `loadingOutput` is in this
    // effect's own dependency array, so the write below re-runs the effect
    // immediately and a lifetime-scoped flag would be flipped by its own
    // cleanup before the response landed. The re-run early-returns without
    // bumping, so the in-flight request stays current and only a genuinely
    // newer one supersedes it.
    const req = ++outputRequestRef.current;
    const current = () => req === outputRequestRef.current;
    setLoadingOutput(true);
    getCosAgent(agent.id, { silent: true })
      .then(data => {
        if (current()) {
          setFullOutput(toTranscript(data));
          setFullMetadata(data.metadata || null);
        }
      })
      .catch(err => {
        if (!current()) return;
        // A live-list record may still hold its streamed output; a history row
        // never does, so without one the failure has to stay visible.
        if (agent.output?.length > 0) setFullOutput(toTranscript(agent));
        else setOutputError(err?.message || 'Request failed');
      })
      .finally(() => { if (current()) setLoadingOutput(false); });
  }, [expanded, inactive, agent.id, fullOutput, loadingOutput, outputError, remote, agent.output]);

  const reloadOutput = useCallback(() => {
    setOutputError(null);
    setFullOutput(null);
  }, []);

  // For running agents, use live output; for completed, use the fetched transcript tail or stored
  const output = useMemo(() => (
    inactive
      ? (fullOutput?.lines || agent.output || [])
      : (liveOutput || agent.output || [])
  ), [inactive, fullOutput, liveOutput, agent.output]);
  // Live output renders tail-first (see OutputBlocks `anchor`), so the panel
  // follows the newest line until the reader scrolls up. The array identity is
  // the revision: the live buffer is capped, so its length stops moving.
  const outputPanelRef = useRef(null);
  useStickToBottom(outputPanelRef, { enabled: expanded && !inactive, revision: output });
  const taskSummary = completed && (fullMetadata && Object.hasOwn(fullMetadata, 'taskSummary')
    ? fullMetadata.taskSummary : agent.metadata?.taskSummary);

  // Pipeline stage info: build stage list with agentIds from stageResults
  const pipelineStages = useMemo(() => {
    const pipeline = agent.metadata?.pipeline;
    if (!pipeline?.stages || pipeline.stages.length < 2) return null;
    const results = pipeline.stageResults || [];
    return pipeline.stages.map((stage, idx) => {
      const result = results.find(r => r.stage === idx);
      return {
        index: idx,
        name: stage.name,
        agentId: result?.agentId || (idx === pipeline.currentStage ? agent.id : null),
        success: result?.success,
        isCurrent: idx === (pipeline.currentStage ?? 0),
        completed: !!result
      };
    });
  }, [agent.metadata?.pipeline, agent.id]);

  // Initialize activeStageTab to current stage when pipeline is detected
  useEffect(() => {
    if (pipelineStages && activeStageTab === null) {
      const current = pipelineStages.find(s => s.isCurrent);
      setActiveStageTab(current?.index ?? pipelineStages.length - 1);
    }
  }, [pipelineStages, activeStageTab]);

  // Fetch output for a prior pipeline stage agent
  const fetchStageOutput = useCallback(async (stageAgentId) => {
    if (!stageAgentId || stageOutputs[stageAgentId] || stageInFlightRef.current.has(stageAgentId)) return;
    stageInFlightRef.current.add(stageAgentId);
    setLoadingStageIds(new Set(stageInFlightRef.current));
    setStageErrors(({ [stageAgentId]: _cleared, ...rest }) => rest);
    let failure = null;
    const data = await getCosAgent(stageAgentId, { silent: true }).catch(err => {
      failure = err?.message || 'Request failed';
      return null;
    });
    // Only a successful read is cached: a cached empty transcript would claim
    // the stage captured nothing and suppress every later fetch.
    if (failure) setStageErrors(prev => ({ ...prev, [stageAgentId]: failure }));
    else setStageOutputs(prev => ({ ...prev, [stageAgentId]: toTranscript(data) }));
    stageInFlightRef.current.delete(stageAgentId);
    setLoadingStageIds(new Set(stageInFlightRef.current));
  }, [stageOutputs]);

  // Auto-fetch stage output when switching to a prior stage tab
  useEffect(() => {
    if (!pipelineStages || activeStageTab === null) return;
    const stage = pipelineStages[activeStageTab];
    if (!stage?.isCurrent && stage?.agentId && !stageOutputs[stage.agentId] && !stageErrors[stage.agentId]) {
      fetchStageOutput(stage.agentId);
    }
  }, [activeStageTab, pipelineStages, stageOutputs, stageErrors, fetchStageOutput]);

  return {
    expanded, setExpanded, transcriptExpanded, setTranscriptExpanded, fullOutput, fullMetadata, loadingOutput, outputError,
    activeStageTab, setActiveStageTab, stageOutputs, loadingStageIds, stageErrors, reloadOutput, output, outputPanelRef,
    taskSummary, pipelineStages, fetchStageOutput,
  };
}

function useRuntime({ agent, inactive, expanded, remote, durations }) {
  // The elapsed-time display shares the app-wide one-second ticker (one timer
  // for N running cards, paused in a hidden tab) and unsubscribes once the run
  // is finished or paused, where the duration no longer moves.
  const now = useTimeTick(1000, { enabled: !inactive });

  // Read only for an expanded, active local agent. The resource key discards
  // in-flight responses after collapsing, switching agents, or going inactive.
  const statsEnabled = expanded && !inactive && !remote;
  const { data: processStats } = useSocketResource(
    () => statsEnabled ? getCosAgentStats(agent.id, { silent: true }) : null,
    {
      namespace: 'cos',
      enabled: statsEnabled,
      events: STATS_EVENTS,
      resourceKey: statsEnabled ? agent.id : null,
      matchesEvent: payload => statsEnabled && (payload?.agentId ?? payload?.id) === agent.id,
    },
  );

  const duration = agent.completedAt
    ? new Date(agent.completedAt) - new Date(agent.startedAt)
    : now - new Date(agent.startedAt);

  // Calculate duration estimate for running agents
  // Uses P80 (80th percentile approximation) for progress bars to prevent premature 100%
  const durationEstimate = useMemo(() => {
    if (inactive) return null;
    // The shared 4-rung cascade (#8001): this run's provider/model/effort first,
    // falling outward to the plain task-type average. `TaskItem` estimates through
    // the same module, so a pending task and the agent it becomes agree.
    return estimateCosDuration({
      durations,
      task: {
        description: agent.metadata?.taskDescription,
        taskType: agent.metadata?.taskType,
        metadata: agent.metadata
      },
      agentMetadata: agent.metadata
    });
  }, [inactive, durations, agent.metadata]);

  // Calculate progress percentage using P80-based estimate
  // Cap at 99% for active tasks — only completion can land on 100%
  const progress = useMemo(() => {
    if (!durationEstimate) return null;
    const percent = Math.min(99, Math.round((duration / durationEstimate.estimatedMs) * 100));
    return percent;
  }, [duration, durationEstimate]);

  // Calculate remaining time (ETA) based on P80 estimate
  const remainingTime = useMemo(() => {
    if (!durationEstimate || inactive) return null;
    const remaining = durationEstimate.estimatedMs - duration;
    if (remaining <= 0) return { remaining: 0, overBy: Math.abs(remaining), isOvertime: true };
    return { remaining, overBy: 0, isOvertime: false };
  }, [duration, durationEstimate, inactive]);

  // Why this run has NO "Open Shell" link. Scoped to the one case where the user
  // configured a TUI provider and got no shell anyway: a public-review stage
  // runs headless unless it is the sandboxed-actions stage on a provider whose
  // vendor declares an attachable recipe. An ordinary headless CLI agent gets no
  // chip — nobody expected a shell there, and one on every card would be the
  // noise this exists to remove.
  //
  // `executionMode` is the authority on which way the run actually spawned, and
  // it is stamped at registration while `tuiSessionId` only lands once the PTY
  // attaches. An ATTACHABLE public-review stage therefore passes through a
  // window where the session id is still null — without this second condition
  // the card would spend that window asserting the stage runs headless, then
  // silently swap the claim for an "Open Shell" link (same reason the ordinary
  // TUI case is excluded below).
  const noShellReason = !agent.metadata?.tuiSessionId
    && agent.metadata?.executionMode !== 'tui'
    && agent.metadata?.publicReviewPosture
    ? 'No shell: this public-review stage runs headless — either it is a tool-free reasoning stage, or its provider has no attachable sandbox recipe — so the screened PR content stays inside the sandboxed child. Watch the live output below to see what it is doing.'
    : null;

  // Why this run can be silent for minutes and still be perfectly healthy: its
  // prompt is large and its model server is on this machine, so the whole
  // prefill happens before the child emits its first line (#6117). Only shown
  // when the server actually stamped a long-prefill budget — an absent stamp is
  // "no estimate" (a cloud run, or a pre-upgrade record), never "instant".
  const prefillBudget = agent.metadata?.localPromptBudget?.longPrefill
    && Number.isFinite(agent.metadata.localPromptBudget.prefillMs)
    ? agent.metadata.localPromptBudget
    : null;
  const prefillLabel = prefillBudget ? formatDurationMs(prefillBudget.prefillMs) : null;
  const prefillReason = prefillBudget
    ? `Large prompt (~${formatCount(prefillBudget.promptTokens, { fallback: '0' })} tokens) on a local model server — expect roughly ${prefillLabel} of silent prefill before the first line of output. The run is working, not wedged.${
      prefillBudget.expectedDurationMs
        ? ` Its duration estimate was raised to ~${formatDurationMs(prefillBudget.expectedDurationMs)} to cover it.`
        : ''}`
    : null;

  return { processStats, duration, durationEstimate, progress, remainingTime, noShellReason, prefillReason, prefillLabel };
}

function usePrompt(agentId) {
  const [promptContent, setPromptContent] = useState(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [promptError, setPromptError] = useState(null);

  // Open the prompt modal — lazy-fetches prompt.txt the first time it opens.
  // Useful for iterating on the prompt itself (the user can see exactly what
  // was pasted into the TUI / sent to the CLI and decide what to trim).
  const openPromptModal = useCallback(async () => {
    setPromptOpen(true);
    if (promptContent !== null || loadingPrompt) return;
    setLoadingPrompt(true);
    setPromptError(null);
    const result = await getCosAgentPrompt(agentId).catch(err => {
      setPromptError(err.message);
      return null;
    });
    setLoadingPrompt(false);
    if (result?.prompt) setPromptContent(result.prompt);
  }, [agentId, promptContent, loadingPrompt]);

  const copyPromptToClipboard = useCallback(() => {
    copyToClipboard(promptContent, 'Prompt copied to clipboard');
  }, [promptContent]);

  return { promptOpen, promptContent, loadingPrompt, promptError, openPromptModal, copyPromptToClipboard, closePrompt: () => setPromptOpen(false) };
}
