import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router';
import {
  Cpu,
  Trash2,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
  Loader2,
  Skull,
  Pause,
  Activity,
  Clock,
  Brain,
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  ExternalLink,
  Terminal,
  Hourglass,
  Send,
  GitBranch,
  GitPullRequest,
  Sparkles,
  RefreshCw,
  Copy,
  Target
} from 'lucide-react';
import * as api from '../../../services/api';
import OutputBlocks from '../OutputBlocks';
import MarkdownOutput from '../MarkdownOutput';
import Modal from '../../ui/Modal';
import CollapsibleText from '../../ui/CollapsibleText';
import toast from '../../ui/Toast';
import { copyToClipboard } from '../../../lib/clipboard';
import { extractCosTaskType } from '../../../lib/cosTaskType';
import { DEFAULT_REVIEWER, normalizeReviewers } from '../constants';
import { formatBytes, formatDurationMs, formatDateTime, formatMonthDay, formatTimeOfDay } from '../../../utils/formatters';
import { useAutoRefetch } from '../../../hooks/useAutoRefetch';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';

// Pre-compiled regexes for normalizeDescriptionToMarkdown
// Avoid lookbehind to support older Safari/iOS runtimes
const RE_NUMBERED_LIST = /([.!?:]) (\d+)\. /g;
const RE_DASH_LIST = /([.!?:]) - /g;
const RE_SECTION_LABELS = / (Expected output|Steps|Success criteria|Actionable focus|Focus|Suggestions?|Notes?|Context|Requirements?|Constraints?|Result|Output|Summary|Details)([: ])/gi;
const FINISH_SENTINEL_MESSAGE = 'Finish work and write sentinel.';

// Normalize raw task description text into markdown for readable rendering.
// Descriptions often arrive as a single long line with embedded numbered lists,
// bullet points, and section headers. This splits them onto separate lines so
// ReactMarkdown can format them properly.
function normalizeDescriptionToMarkdown(text) {
  if (!text) return '';
  return text
    .replace(RE_NUMBERED_LIST, '$1\n$2. ')
    .replace(RE_DASH_LIST, '$1\n- ')
    .replace(RE_SECTION_LABELS, '\n\n**$1**$2')
    .trim();
}

// Markdown-rendered task description, height-clamped behind a Show more toggle.
// `line-clamp` can't clamp this — MarkdownOutput emits block children — so it
// uses CollapsibleText's max-height variant, which measures the real overflow
// instead of guessing from a character count.
function TaskDescription({ id, text }) {
  const md = useMemo(() => normalizeDescriptionToMarkdown(text), [text]);

  if (!text) return null;

  return (
    <div className="mb-2">
      <CollapsibleText id={`agent-desc-${id}`} className="text-sm">
        <MarkdownOutput content={md} />
      </CollapsibleText>
    </div>
  );
}

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

function TranscriptTruncationNotice({ transcript }) {
  if (!transcript?.truncated) return null;
  const count = transcript.lines.length;
  const size = transcript.totalBytes > 0 ? ` (${formatBytes(transcript.totalBytes)})` : '';
  return (
    <div className="flex items-center gap-1.5 text-xs text-yellow-500 mb-2">
      <AlertTriangle size={12} aria-hidden="true" className="shrink-0" />
      <span>
        {count > 0
          ? `Showing the last ${count.toLocaleString()} ${count === 1 ? 'line' : 'lines'} — the full transcript${size} is on disk in the agent's output.txt.`
          : `The tail of this transcript held no readable lines — the full transcript${size} is on disk in the agent's output.txt.`}
      </span>
    </div>
  );
}

// Goal-fidelity verdict (#5994) — did this run build what the task asked for?
// Distinct from the quality reviewers, which never see the request. Rendered
// whatever the verdict: a `ship` is the evidence the gate ran, and its absence
// is what tells the reader the run was never judged against its objective.
//
// `missing` / `unrequested` are model-authored text derived from an untrusted
// diff, so they render as plain list items — never a link, path, or command.
const GOAL_FIDELITY_TONE = {
  ship: { border: 'border-port-success/30', text: 'text-port-success', label: 'Delivers the objective' },
  'fix-first': { border: 'border-port-warning/30', text: 'text-port-warning', label: 'Delivers it, with gaps' },
  rethink: { border: 'border-port-error/40', text: 'text-port-error', label: 'Does not deliver the objective' }
};

function GoalFidelityPanel({ review }) {
  const tone = GOAL_FIDELITY_TONE[review?.verdict];
  if (!tone) return null;
  return (
    <div className={`mt-2 bg-port-bg/50 border rounded p-2.5 ${tone.border}`}>
      <div className={`text-[11px] flex items-center gap-1 ${tone.text}`}>
        <Target size={10} aria-hidden="true" />
        Goal fidelity: {tone.label}
        <span className="text-gray-500">
          ({review.verdict}{review.model ? ` · ${review.model}` : ''}{review.diffTruncated ? ' · partial diff' : ''})
        </span>
      </div>
      {review.missing?.length > 0 && (
        <div className="mt-1.5 text-xs text-gray-400">
          <span className="text-gray-500">Asked for but missing:</span>
          <ul className="list-disc list-inside">
            {review.missing.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
      {review.unrequested?.length > 0 && (
        <div className="mt-1.5 text-xs text-gray-400">
          <span className="text-gray-500">Not asked for:</span>
          <ul className="list-disc list-inside">
            {review.unrequested.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
      {review.evidence && <p className="mt-1.5 text-xs text-gray-400">{review.evidence}</p>}
    </div>
  );
}

export default function AgentCard({ agent, onPause, onKill, onDelete, onResume, onRelaunch, completed, paused = false, liveOutput, durations, onFeedbackChange, remote, peerName }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [fullOutput, setFullOutput] = useState(null);
  const [loadingOutput, setLoadingOutput] = useState(false);
  // Pipeline stage output: track which stage tab is active and cached outputs per stage agentId
  const [activeStageTab, setActiveStageTab] = useState(null);
  const [stageOutputs, setStageOutputs] = useState({});
  const [loadingStageId, setLoadingStageId] = useState(null);
  const [processStats, setProcessStats] = useState(null);
  const [pausing, setPausing] = useState(false);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const [killing, setKilling] = useState(false);
  const [confirmingKill, setConfirmingKill] = useState(false);
  const [feedbackState, setFeedbackState] = useState(agent.feedback?.rating || null);
  const [btwInput, setBtwInput] = useState('');
  const [sendingBtw, setSendingBtw] = useState(false);
  const [btwMessages, setBtwMessages] = useState(agent.btwMessages || []);
  const [promptContent, setPromptContent] = useState(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [promptError, setPromptError] = useState(null);

  // Sync feedback state when parent refreshes agent data
  useEffect(() => {
    if (agent.feedback?.rating) setFeedbackState(agent.feedback.rating);
  }, [agent.feedback?.rating]);

  // Sync btw messages from parent when agent data refreshes
  useEffect(() => {
    setBtwMessages(agent.btwMessages || []);
  }, [agent.btwMessages]);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [showFeedbackComment, setShowFeedbackComment] = useState(false);
  const [feedbackComment, setFeedbackComment] = useState(agent.feedback?.comment || '');

  // Determine if this is a system agent (health check, etc.)
  const isSystemAgent = agent.taskId?.startsWith('sys-') || agent.id?.startsWith('sys-');
  // Only agents from a manually-filled task form ask for a rating —
  // scheduled/autopilot runs are already auto-evaluated by task-learning.
  const isManualUserAgent = agent.metadata?.taskType === 'user';
  const inactive = completed || paused;

  // Handle feedback submission
  const submitFeedback = useCallback(async (rating) => {
    if (submittingFeedback) return;
    setSubmittingFeedback(true);

    const result = await api.submitCosAgentFeedback(agent.id, {
      rating,
      comment: feedbackComment || undefined
    }, { silent: true }).catch(err => {
      toast.error(`Failed to submit feedback: ${err.message}`);
      return null;
    });

    setSubmittingFeedback(false);

    if (result?.success) {
      setFeedbackState(rating);
      setShowFeedbackComment(false);
      setFeedbackComment(result.agent?.feedback?.comment || '');
      toast.success(`Feedback recorded: ${rating}`);
      onFeedbackChange?.(result.agent);
    }
  }, [agent.id, feedbackComment, submittingFeedback, onFeedbackChange]);

  // Open the prompt modal — lazy-fetches prompt.txt the first time it opens.
  // Useful for iterating on the prompt itself (the user can see exactly what
  // was pasted into the TUI / sent to the CLI and decide what to trim).
  const openPromptModal = useCallback(async () => {
    setPromptOpen(true);
    if (promptContent !== null || loadingPrompt) return;
    setLoadingPrompt(true);
    setPromptError(null);
    const result = await api.getCosAgentPrompt(agent.id).catch(err => {
      setPromptError(err.message);
      return null;
    });
    setLoadingPrompt(false);
    if (result?.prompt) setPromptContent(result.prompt);
  }, [agent.id, promptContent, loadingPrompt]);

  const copyPromptToClipboard = useCallback(() => {
    copyToClipboard(promptContent, 'Prompt copied to clipboard');
  }, [promptContent]);

  // Send a message to the running agent
  const sendBtw = useCallback(async (message = btwInput.trim(), label = 'BTW message') => {
    if (sendingBtw || !message) return;
    setSendingBtw(true);

    const result = await api.sendCosAgentBtw(agent.id, message, { silent: true }).catch(err => {
      toast.error(`Failed to send: ${err.message}`);
      return null;
    });

    setSendingBtw(false);

    if (result?.success) {
      setBtwMessages(prev => [...prev, { message, timestamp: new Date().toISOString() }]);
      if (message === btwInput.trim()) setBtwInput('');
      toast.success(`${label} sent to agent`);
    }
  }, [agent.id, btwInput, sendingBtw]);

  // Update duration display for running agents
  useEffect(() => {
    if (inactive) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [inactive]);

  // Fetch process stats for running agents (skip for remote peers).
  // Only overwrite prior stats on a successful response so a transient
  // error doesn't blank out the previously displayed CPU/mem/PID.
  const fetchStats = useCallback(async () => {
    try {
      const stats = await api.getCosAgentStats(agent.id, { silent: true });
      setProcessStats(stats);
    } catch {
      // preserve last-good stats on transient blip
    }
  }, [agent.id]);

  useAutoRefetch(fetchStats, 5000, { enabled: !inactive && !remote, pollOnly: true });

  const handlePause = async () => {
    if (!onPause) return;
    setPausing(true);
    await onPause(agent.id);
    setPausing(false);
  };

  const handleKill = async () => {
    if (!onKill) return;
    setKilling(true);
    try {
      await onKill(agent.id);
    } finally {
      setKilling(false);
      setConfirmingKill(false);
    }
  };

  // Fetch full output when expanded for completed agents (skip for remote)
  useEffect(() => {
    if (expanded && inactive && !fullOutput && !loadingOutput && !remote) {
      setLoadingOutput(true);
      api.getCosAgent(agent.id)
        .then(data => {
          setFullOutput(toTranscript(data));
        })
        .catch(() => {
          // Fall back to agent's stored output
          setFullOutput(toTranscript(agent));
        })
        .finally(() => setLoadingOutput(false));
    }
  }, [expanded, inactive, agent.id, fullOutput, loadingOutput, remote, agent.output]);

  const duration = agent.completedAt
    ? new Date(agent.completedAt) - new Date(agent.startedAt)
    : now - new Date(agent.startedAt);

  // Calculate duration estimate for running agents
  // Uses P80 (80th percentile approximation) for progress bars to prevent premature 100%
  const durationEstimate = useMemo(() => {
    if (inactive || !durations) return null;

    const taskType = extractCosTaskType({
      description: agent.metadata?.taskDescription,
      taskType: agent.metadata?.taskType,
      metadata: agent.metadata
    });
    const typeData = durations[taskType];
    const overallData = durations._overall;

    if (typeData && typeData.avgDurationMs) {
      return {
        estimatedMs: typeData.p80DurationMs || typeData.avgDurationMs,
        avgMs: typeData.avgDurationMs,
        basedOn: typeData.completed,
        taskType,
        isTypeSpecific: true
      };
    }

    if (overallData && overallData.avgDurationMs) {
      return {
        estimatedMs: overallData.p80DurationMs || overallData.avgDurationMs,
        avgMs: overallData.avgDurationMs,
        basedOn: overallData.completed,
        taskType: 'all tasks',
        isTypeSpecific: false
      };
    }

    return null;
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

  // For running agents, use live output; for completed, use the fetched transcript tail or stored
  const output = useMemo(() => (
    inactive
      ? (fullOutput?.lines || agent.output || [])
      : (liveOutput || agent.output || [])
  ), [inactive, fullOutput, liveOutput, agent.output]);
  const lastOutput = output.length > 0 ? output[output.length - 1]?.line : null;

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
    ? `Large prompt (~${(prefillBudget.promptTokens ?? 0).toLocaleString()} tokens) on a local model server — expect roughly ${prefillLabel} of silent prefill before the first line of output. The run is working, not wedged.${
      prefillBudget.expectedDurationMs
        ? ` Its duration estimate was raised to ~${formatDurationMs(prefillBudget.expectedDurationMs)} to cover it.`
        : ''}`
    : null;

  // Extract recent tool activity (last few tool lines) for live display
  const recentActivity = useMemo(() => {
    if (inactive || output.length === 0) return [];
    const recent = [];
    // Walk backwards to find the last 3 tool actions (🔧 lines with their → details)
    for (let i = output.length - 1; i >= 0 && recent.length < 6; i--) {
      const line = output[i]?.line || '';
      if (line.startsWith('🔧') || line.startsWith('  →')) {
        recent.unshift(output[i]);
      }
    }
    return recent;
  }, [inactive, output]);

  // Count total tool invocations
  const toolCount = useMemo(() => {
    return output.filter(o => o?.line?.startsWith('🔧')).length;
  }, [output]);

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
    if (!stageAgentId || stageOutputs[stageAgentId] || loadingStageId) return;
    setLoadingStageId(stageAgentId);
    const data = await api.getCosAgent(stageAgentId).catch(() => null);
    setStageOutputs(prev => ({ ...prev, [stageAgentId]: toTranscript(data) }));
    setLoadingStageId(null);
  }, [stageOutputs, loadingStageId]);

  // Auto-fetch stage output when switching to a prior stage tab
  useEffect(() => {
    if (!pipelineStages || activeStageTab === null) return;
    const stage = pipelineStages[activeStageTab];
    if (!stage?.isCurrent && stage?.agentId && !stageOutputs[stage.agentId]) {
      fetchStageOutput(stage.agentId);
    }
  }, [activeStageTab, pipelineStages, stageOutputs, fetchStageOutput]);

  return (
    <div className={`bg-port-card border rounded-lg overflow-hidden ${
      inactive
        ? isSystemAgent ? 'border-port-border opacity-50' : 'border-port-border opacity-75'
        : 'border-port-accent/50'
    }`}>
      <div className="p-4">
        {/* Top row: Agent ID, badges, and actions */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
            <Cpu size={16} aria-hidden="true" className={`shrink-0 ${inactive ? 'text-gray-500' : 'text-port-accent animate-pulse'}`} />
            <span className="font-mono text-sm text-gray-400 truncate">{agent.id}</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                copyToClipboard(agent.id, 'Agent ID copied to clipboard');
              }}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 rounded text-gray-500 hover:bg-port-border/60 hover:text-white transition-colors shrink-0"
              title="Copy agent ID"
              aria-label="Copy agent ID"
            >
              <Copy size={13} aria-hidden="true" />
            </button>
            {remote && peerName && (
              <span className="px-1.5 py-0.5 text-xs bg-port-accent/20 text-port-accent rounded shrink-0" title={`Remote agent on ${peerName}`}>
                {peerName}
              </span>
            )}
            {agent.metadata?.taskApp && (agent.metadata.taskAppName || agent.metadata.workspaceName) && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(agent.metadata.taskAppName || agent.metadata.workspaceName) && (
              <span className="px-1.5 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 rounded shrink-0" title={agent.metadata.workspacePath || agent.metadata.taskApp}>
                {agent.metadata.taskAppName || agent.metadata.workspaceName}
              </span>
            )}
            {agent.metadata?.pipeline?.stages?.length > 0 && (
              <span className="px-1.5 py-0.5 text-xs bg-purple-500/20 text-purple-400 rounded shrink-0" title={agent.metadata.pipeline.stages[agent.metadata.pipeline.currentStage]?.name}>
                Stage {(agent.metadata.pipeline.currentStage ?? 0) + 1}/{agent.metadata.pipeline.stages.length}
              </span>
            )}
            {isSystemAgent && (
              <span className="px-1.5 py-0.5 text-xs bg-gray-500/20 text-gray-400 rounded shrink-0">SYS</span>
            )}
            {agent.metadata?.model && (
              <span className={`px-2 py-0.5 text-xs rounded shrink-0 ${
                agent.metadata.modelTier === 'heavy' ? 'bg-purple-500/20 text-purple-400' :
                agent.metadata.modelTier === 'light' ? 'bg-green-500/20 text-green-400' :
                'bg-blue-500/20 text-blue-400'
              }`} title={agent.metadata.modelReason}>
                {agent.metadata.model.replace('claude-', '').replace(/-\d+$/, '')}
              </span>
            )}
            {!inactive && (
              <span className={`px-2 py-0.5 text-xs rounded animate-pulse shrink-0 ${
                agent.metadata?.phase === 'initializing' ? 'bg-yellow-500/20 text-yellow-400' :
                'bg-port-accent/20 text-port-accent'
              }`}>
                {agent.metadata?.phase === 'initializing' ? 'Initializing'
                    : 'Working'}
              </span>
            )}
            {paused && (
              <span className="px-2 py-0.5 text-xs rounded bg-yellow-500/20 text-yellow-400 shrink-0">
                Paused
              </span>
            )}
            {agent.metadata?.executionMode === 'tui' && (
              <span className="px-2 py-0.5 text-xs rounded bg-emerald-500/20 text-emerald-400 shrink-0">
                TUI
              </span>
            )}
          </div>
          {/* Actions - right side */}
          <div className="flex items-center gap-2 shrink-0">
            {(output.length > 0 || inactive) && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-gray-500 hover:text-white transition-colors text-xs whitespace-nowrap"
                aria-expanded={expanded}
              >
                {expanded ? 'Hide' : 'Show'}
              </button>
            )}
            {!inactive && onRelaunch && (
              <button
                onClick={() => onRelaunch(agent)}
                className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
                aria-label="Relaunch this agent's task on a different provider or model"
              >
                <RefreshCw size={12} aria-hidden="true" />
                <span className="hidden sm:inline">Relaunch</span>
              </button>
            )}
            {!inactive && onPause && (
              <button
                onClick={handlePause}
                disabled={pausing}
                className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors disabled:opacity-50"
                aria-label="Pause agent and preserve worktree"
              >
                {pausing ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <Pause size={12} aria-hidden="true" />}
                <span className="hidden sm:inline">Pause</span>
              </button>
            )}
            {/* Kill button (force SIGKILL) */}
            {!inactive && onKill && (
              confirmingKill ? (
                <ConfirmButtonPair
                  prompt="Kill?"
                  confirmText="Confirm"
                  cancelText="Cancel"
                  ariaLabel="Confirm kill agent"
                  confirmIcon={Skull}
                  busy={killing}
                  onConfirm={handleKill}
                  onCancel={() => setConfirmingKill(false)}
                />
              ) : (
                <button
                  onClick={() => setConfirmingKill(true)}
                  disabled={killing}
                  className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-port-error/20 text-port-error hover:bg-port-error/30 transition-colors disabled:opacity-50"
                  aria-label="Force kill agent (SIGKILL)"
                >
                  {killing ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <Skull size={12} aria-hidden="true" />}
                  <span className="hidden sm:inline">Kill</span>
                </button>
              )
            )}
            {(completed || paused) && onResume && (
              <button
                onClick={() => onResume(agent)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
                aria-label={paused
                  ? "Resume this agent's task on its preserved worktree"
                  : "Create new task from this agent's context"}
              >
                <RotateCcw size={12} aria-hidden="true" />
                <span className="hidden sm:inline">Resume</span>
              </button>
            )}
            {(completed || paused) && onDelete && (
              isConfirming(agent.id) ? (
                <ConfirmButtonPair
                  prompt="Remove?"
                  confirmText="Remove"
                  ariaLabel="Confirm remove agent"
                  onConfirm={() => confirmDelete(() => onDelete(agent.id))}
                  onCancel={cancelDelete}
                />
              ) : (
                <button
                  onClick={() => requestDelete(agent.id)}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error transition-colors"
                  aria-label="Remove agent"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              )
            )}
          </div>
        </div>

        {/* Second row: Runtime, ETA, and process stats - compact inline display */}
        <div className="flex items-center gap-2 flex-wrap text-xs mb-2">
          {/* Duration with ETA for running agents */}
          {!inactive && durationEstimate ? (
            <span
              className="flex items-center gap-1.5 text-gray-500 whitespace-nowrap"
              title={`Based on ${durationEstimate.basedOn} completed ${durationEstimate.taskType} tasks (avg: ${formatDurationMs(durationEstimate.avgMs)}, est: ${formatDurationMs(durationEstimate.estimatedMs)})`}
            >
              <Clock size={12} aria-hidden="true" className="shrink-0" />
              <span className="font-mono">{formatDurationMs(duration)}</span>
              {remainingTime && !remainingTime.isOvertime && (
                <>
                  <span className="text-gray-600">→</span>
                  <span className="font-mono text-port-accent">~{formatDurationMs(remainingTime.remaining)} left</span>
                </>
              )}
              {remainingTime?.isOvertime && (
                <>
                  <span className="text-gray-600">→</span>
                  <span className="font-mono text-yellow-500">+{formatDurationMs(remainingTime.overBy)}</span>
                </>
              )}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-gray-500 whitespace-nowrap">
              <Clock size={12} aria-hidden="true" className="shrink-0" />
              <span className="font-mono">{formatDurationMs(duration)}</span>
            </span>
          )}
          {/* Completed timestamp */}
          {completed && agent.completedAt && (
            <>
              <span className="text-gray-600">|</span>
              <span className="text-gray-500 whitespace-nowrap" title={formatDateTime(agent.completedAt)}>
                {formatMonthDay(agent.completedAt)}{' '}
                {formatTimeOfDay(agent.completedAt)}
              </span>
            </>
          )}
          {/* Process stats for running agents - inline */}
          {!inactive && processStats?.active && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-success/20 text-port-success whitespace-nowrap"
                  title={`PID: ${processStats.pid} | State: ${processStats.state}`}>
              <Activity size={10} aria-hidden="true" className="shrink-0" />
              <span className="font-mono">PID {processStats.pid}</span>
              <span className="text-port-success/70">|</span>
              <span className="font-mono">{processStats.cpu?.toFixed(1)}%</span>
              <span className="text-port-success/70">|</span>
              <span className="font-mono">{processStats.memoryMb}MB</span>
            </span>
          )}
          {!inactive && agent.metadata?.tuiSessionId && (
            <Link
              to={`/shell?session=${encodeURIComponent(agent.metadata.tuiSessionId)}`}
              className="flex items-center gap-1.5 px-3 py-1 rounded font-semibold bg-emerald-500 text-black hover:bg-emerald-400 shadow-sm ring-1 ring-emerald-400/50 whitespace-nowrap transition-colors"
              title="Open the live TUI shell to inspect and interact with this agent"
            >
              <Terminal size={14} aria-hidden="true" className="shrink-0" />
              <span>Open Shell</span>
              <span className="font-mono text-[10px] text-port-on-success">{agent.metadata.tuiSessionId.slice(0, 6)}</span>
            </Link>
          )}
          {!inactive && noShellReason && (
            <span
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-border/40 text-gray-400 whitespace-nowrap"
              title={noShellReason}
            >
              <Terminal size={10} aria-hidden="true" className="shrink-0" />
              <span>No shell</span>
            </span>
          )}
          {!inactive && prefillReason && (
            <span
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-warning/20 text-port-warning whitespace-nowrap"
              title={prefillReason}
            >
              <Hourglass size={10} aria-hidden="true" className="shrink-0" />
              <span>Long prefill ~{prefillLabel}</span>
            </span>
          )}
          {!remote && (
            <button
              onClick={openPromptModal}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-border/40 text-gray-400 hover:bg-port-border/60 hover:text-white whitespace-nowrap"
              title="View the prompt this agent was given at spawn"
            >
              <MessageSquare size={10} aria-hidden="true" className="shrink-0" />
              <span>Prompt</span>
            </button>
          )}
          {/* Show zombie warning if PID exists but process is dead */}
          {!inactive && agent.pid && processStats && !processStats.active && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-error/20 text-port-error whitespace-nowrap"
                  title="Process is not running - zombie agent">
              <Skull size={10} aria-hidden="true" className="shrink-0" />
              <span className="font-mono">PID {agent.pid}</span>
              <span>ZOMBIE</span>
            </span>
          )}
        </div>
        <TaskDescription id={agent.id} text={agent.metadata?.taskDescription || agent.taskId} />

        {/* JIRA ticket info */}
        {agent.metadata?.jiraTicketId && (
          <div className="flex items-center gap-2 mb-2">
            <span className="px-2 py-0.5 text-xs bg-port-accent/20 text-port-accent rounded font-mono">
              {agent.metadata.jiraTicketId}
            </span>
            {agent.metadata?.jiraTicketUrl && (
              <a
                href={agent.metadata.jiraTicketUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-port-accent hover:text-port-accent/80 transition-colors"
                title="Open JIRA ticket in new tab"
              >
                View ticket
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </div>
        )}

        {/* Agent configuration badges */}
        {(agent.metadata?.configUseWorktree || agent.metadata?.configOpenPR || agent.metadata?.configSimplify || agent.metadata?.configReviewLoop || agent.metadata?.configCodingOnMain) && (
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            {agent.metadata.configUseWorktree && (
              <span className={`flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded ${
                agent.metadata.configWorktreeAutoDetected ? 'bg-orange-500/15 text-orange-400' : 'bg-teal-500/15 text-teal-400'
              }`} title={`Worktree: ${agent.metadata.worktreeBranch || 'unknown'}${agent.metadata.configWorktreeAutoDetected ? ' (auto-detected conflict)' : ''}`}>
                <GitBranch size={10} aria-hidden="true" />
                {agent.metadata.configWorktreeAutoDetected ? 'Auto-WT' : 'Worktree'}
              </span>
            )}
            {agent.metadata.configCodingOnMain && !agent.metadata.configUseWorktree && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-yellow-500/15 text-yellow-500"
                    title="Agent is coding directly on main branch">
                <GitBranch size={10} aria-hidden="true" />
                main
              </span>
            )}
            {agent.metadata.configOpenPR && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-purple-500/15 text-purple-400"
                    title="Will open a PR when done">
                <GitPullRequest size={10} aria-hidden="true" />
                PR
              </span>
            )}
            {agent.metadata.configSimplify && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-emerald-500/15 text-emerald-400"
                    title="Will run /simplify before committing">
                <Sparkles size={10} aria-hidden="true" />
                Simplify
              </span>
            )}
            {agent.metadata.configReviewLoop && (() => {
              const reviewers = normalizeReviewers({
                reviewers: agent.metadata.configReviewers,
                reviewer: agent.metadata.configReviewer
              });
              const isDefault = reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER;
              return (
                <span className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-indigo-500/15 text-indigo-400"
                      title={`Review loop enabled — agent will iterate on PR feedback (reviewers: ${reviewers.join(' → ')})`}>
                  <RefreshCw size={10} aria-hidden="true" />
                  Review{isDefault ? '' : `: ${reviewers.join(', ')}`}
                </span>
              );
            })()}
          </div>
        )}

        {/* Live activity feed for running agents */}
        {!inactive && recentActivity.length > 0 && (
          <div className="text-xs font-mono bg-port-bg/50 px-2 py-1.5 rounded space-y-0.5">
            {recentActivity.map((o, i) => {
              const line = o.line || '';
              if (line.startsWith('🔧')) {
                return <div key={i} className="text-gray-400 truncate">{line}</div>;
              }
              if (line.startsWith('  →')) {
                return <div key={i} className="text-gray-500 truncate pl-4">{line.substring(4)}</div>;
              }
              return <div key={i} className="text-gray-500 truncate">{line.substring(0, 100)}</div>;
            })}
            {toolCount > 3 && (
              <div className="text-gray-600 text-[10px]">{toolCount} tools used</div>
            )}
          </div>
        )}
        {!inactive && recentActivity.length === 0 && lastOutput && (
          <div className="text-xs text-gray-500 font-mono truncate bg-port-bg/50 px-2 py-1 rounded">
            {lastOutput.substring(0, 100)}
          </div>
        )}

        {/* BTW messages sent to this agent */}
        {btwMessages.length > 0 && (
          <div className="mt-2 space-y-1">
            {btwMessages.map((btw, i) => (
              <div key={i} className="flex items-start gap-2 text-xs bg-yellow-500/10 border border-yellow-500/20 rounded px-2 py-1.5">
                <MessageSquare size={12} className="text-yellow-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0">
                  <span className="text-yellow-400">BTW:</span>{' '}
                  <span className="text-gray-300">{btw.message}</span>
                  <span className="text-gray-600 ml-2">{formatTimeOfDay(btw.timestamp)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {!inactive && !remote && agent.metadata?.executionMode === 'tui' && agent.metadata?.tuiKind === 'claude' && (
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={btwInput}
              onChange={(e) => setBtwInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendBtw()}
              placeholder="Send additional context to agent..."
              aria-label="Additional context for the agent"
              className="flex-1 px-2 py-1 text-sm bg-port-bg border border-port-border rounded text-white placeholder-gray-600 focus:outline-hidden focus:border-yellow-500/50 min-h-[32px]"
              maxLength={5000}
              disabled={sendingBtw}
            />
            <button
              onClick={() => sendBtw()}
              disabled={sendingBtw || !btwInput.trim()}
              className="flex items-center gap-1.5 px-3 py-1 text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 rounded transition-colors disabled:opacity-50 min-h-[32px]"
              title="Send BTW message to agent (pastes into the live Claude Code TUI session)"
              data-voice-guard="confirm"
            >
              {sendingBtw ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}
              BTW
            </button>
            <button
              onClick={() => sendBtw(FINISH_SENTINEL_MESSAGE, 'Finish message')}
              disabled={sendingBtw}
              className="flex items-center gap-1.5 px-3 py-1 text-xs bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded transition-colors disabled:opacity-50 min-h-[32px]"
              title="Tell the agent to finish work and write the sentinel"
              aria-label="Finish work and write sentinel"
            >
              {sendingBtw ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <CheckCircle size={12} aria-hidden="true" />}
              Finish
            </button>
          </div>
        )}

        {/* Progress bar and ETA for running agents with estimates */}
        {!inactive && durationEstimate && progress !== null && (
          <div className="mt-2">
            <div className="h-1.5 bg-port-border rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-1000 ease-linear ${
                  remainingTime?.isOvertime ? 'bg-yellow-500' : 'bg-port-accent'
                }`}
                style={{ width: `${Math.min(progress, 99)}%` }}
              />
            </div>
            <div className="flex justify-between mt-1.5 text-xs">
              <span className="text-gray-500">
                {progress}% complete
              </span>
              {remainingTime && !remainingTime.isOvertime && (
                <span className="text-port-accent font-medium">
                  ETA: ~{formatDurationMs(remainingTime.remaining)}
                </span>
              )}
              {remainingTime?.isOvertime && (
                <span className="text-yellow-500 font-medium animate-pulse">
                  +{formatDurationMs(remainingTime.overBy)} over estimate
                </span>
              )}
            </div>
          </div>
        )}

        {agent.result && (
          <div className="flex items-center gap-4 flex-wrap">
            <div className={`text-sm flex items-center gap-2 ${agent.result.success ? 'text-port-success' : 'text-port-error'}`}>
              {agent.result.success ? (
                <><CheckCircle size={14} aria-hidden="true" /> Completed successfully</>
              ) : (
                <><AlertCircle size={14} aria-hidden="true" /> {agent.result.error || 'Failed'}</>
              )}
            </div>
            {/* Cleanup warnings */}
            {agent.result.warnings?.length > 0 && (
              <div className="text-sm text-port-warning flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  {agent.result.warnings.map((w, i) => (
                    <p key={i}>{w}</p>
                  ))}
                </div>
              </div>
            )}
            {/* Memory extraction status */}
            {agent.result.success && (
              <div className={`text-sm flex items-center gap-1 ${
                agent.memoryExtraction?.created > 0 ? 'text-purple-400' :
                agent.memoryExtraction?.pendingApproval > 0 ? 'text-yellow-400' : 'text-gray-500'
              }`} title={agent.memoryExtraction?.extractedAt ? `Extracted at ${formatDateTime(agent.memoryExtraction.extractedAt)}` : 'No memories extracted'}>
                <Brain size={14} aria-hidden="true" />
                {agent.memoryExtraction?.created > 0 ? (
                  <span>{agent.memoryExtraction.created} memor{agent.memoryExtraction.created === 1 ? 'y' : 'ies'}</span>
                ) : agent.memoryExtraction?.pendingApproval > 0 ? (
                  <span>{agent.memoryExtraction.pendingApproval} pending</span>
                ) : (
                  <span className="opacity-50">No memories</span>
                )}
              </div>
            )}
          </div>
        )}

        {agent.result?.goalFidelity && <GoalFidelityPanel review={agent.result.goalFidelity} />}

        {completed && (agent.metadata?.taskSummary || agent.metadata?.malwareScan?.reportUrl) && (
          <div className="mt-2 bg-port-bg/50 border border-port-border/50 rounded p-2.5">
            <div className="text-[11px] text-gray-500 mb-1 flex items-center gap-1">
              <Sparkles size={10} aria-hidden="true" className="text-emerald-400" />
              Task Summary
            </div>
            {agent.metadata?.taskSummary && <MarkdownOutput content={agent.metadata.taskSummary} />}
            {agent.metadata?.malwareScan?.reportUrl && (
              <a
                href={api.normalizeBrainScanReportPath(agent.metadata.malwareScan.reportUrl)}
                className={`mt-2 inline-flex items-center gap-1 text-xs hover:underline ${agent.metadata.malwareScan.verdict === 'DANGEROUS' ? 'text-port-error' : 'text-port-accent'}`}
              >
                {agent.metadata.malwareScan.verdict === 'DANGEROUS' ? <Skull size={13} /> : <ExternalLink size={13} />}
                View scan report{agent.metadata.malwareScan.verdict ? ` (${agent.metadata.malwareScan.verdict})` : ''}
              </a>
            )}
          </div>
        )}

        {/* Feedback section - shown for completed, manually-run, non-system local agents */}
        {completed && !isSystemAgent && isManualUserAgent && !remote && (
          <div className="mt-3 pt-3 border-t border-port-border/50">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-gray-500">Was this helpful?</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => submitFeedback('positive')}
                  disabled={submittingFeedback}
                  className={`min-h-[44px] min-w-[44px] flex items-center justify-center p-1.5 rounded transition-colors ${
                    feedbackState === 'positive'
                      ? 'bg-port-success/30 text-port-success'
                      : 'text-gray-500 hover:text-port-success hover:bg-port-success/10'
                  } disabled:opacity-50`}
                  title="Helpful"
                  aria-label="Mark as helpful"
                  aria-pressed={feedbackState === 'positive'}
                >
                  <ThumbsUp size={14} />
                </button>
                <button
                  onClick={() => submitFeedback('negative')}
                  disabled={submittingFeedback}
                  className={`min-h-[44px] min-w-[44px] flex items-center justify-center p-1.5 rounded transition-colors ${
                    feedbackState === 'negative'
                      ? 'bg-port-error/30 text-port-error'
                      : 'text-gray-500 hover:text-port-error hover:bg-port-error/10'
                  } disabled:opacity-50`}
                  title="Not helpful"
                  aria-label="Mark as not helpful"
                  aria-pressed={feedbackState === 'negative'}
                >
                  <ThumbsDown size={14} />
                </button>
                <button
                  onClick={() => setShowFeedbackComment(!showFeedbackComment)}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center p-1.5 rounded text-gray-500 hover:text-white hover:bg-port-border/50 transition-colors"
                  title={feedbackState ? 'Add feedback detail' : 'Add feedback comment'}
                  aria-label={feedbackState ? 'Add feedback detail' : 'Add feedback comment'}
                  aria-expanded={showFeedbackComment}
                >
                  <MessageSquare size={14} />
                </button>
              </div>
              {feedbackState && (
                <span className={`text-xs ${feedbackState === 'positive' ? 'text-port-success' : feedbackState === 'negative' ? 'text-port-error' : 'text-gray-400'}`}>
                  {feedbackState === 'positive' ? 'Thanks for the feedback!' : feedbackState === 'negative' ? 'We\'ll improve' : 'Feedback recorded'}
                </span>
              )}
            </div>
            {/* Comment input */}
            {showFeedbackComment && (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={feedbackComment}
                  onChange={(e) => setFeedbackComment(e.target.value)}
                  placeholder="What made this work well or poorly?"
                  aria-label="Feedback comment"
                  className="flex-1 px-2 py-1 text-sm bg-port-bg border border-port-border rounded text-white placeholder-gray-500 focus:outline-hidden focus:border-port-accent min-h-[32px]"
                  maxLength={200}
                />
                {feedbackState ? (
                  <button
                    onClick={() => submitFeedback(feedbackState)}
                    disabled={submittingFeedback || !feedbackComment.trim()}
                    className="px-3 py-1 text-xs bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50 min-h-[32px]"
                  >
                    Save detail
                  </button>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    <button
                      onClick={() => submitFeedback('positive')}
                      disabled={submittingFeedback || !feedbackComment.trim()}
                      className="px-2 py-1 text-xs text-port-success border border-port-success/40 hover:bg-port-success/10 rounded disabled:opacity-50 min-h-[32px]"
                    >
                      Helpful
                    </button>
                    <button
                      onClick={() => submitFeedback('negative')}
                      disabled={submittingFeedback || !feedbackComment.trim()}
                      className="px-2 py-1 text-xs text-port-error border border-port-error/40 hover:bg-port-error/10 rounded disabled:opacity-50 min-h-[32px]"
                    >
                      Needs work
                    </button>
                    <button
                      onClick={() => submitFeedback('neutral')}
                      disabled={submittingFeedback || !feedbackComment.trim()}
                      className="px-2 py-1 text-xs text-gray-300 border border-port-border hover:bg-port-border/50 rounded disabled:opacity-50 min-h-[32px]"
                    >
                      Neutral
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Expanded output view */}
      {expanded && (
        <div className="border-t border-port-border bg-port-bg/50 p-3 min-w-0 overflow-y-auto max-h-dvh-cap [--dvh-cap:60dvh]">
          {/* Pipeline stage tabs */}
          {pipelineStages && (
            <div className="flex items-center gap-1 mb-2 overflow-x-auto">
              {pipelineStages.map((stage) => {
                const isActive = activeStageTab === stage.index;
                return (
                  <button
                    key={stage.index}
                    onClick={() => setActiveStageTab(stage.index)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded whitespace-nowrap transition-colors ${
                      isActive
                        ? 'bg-purple-500/20 text-purple-400'
                        : 'text-gray-500 hover:text-gray-300 hover:bg-port-border/30'
                    }`}
                  >
                    {stage.completed && (
                      <span className={stage.success ? 'text-port-success' : 'text-port-error'}>
                        {stage.success ? '●' : '✕'}
                      </span>
                    )}
                    {stage.isCurrent && !stage.completed && (
                      <span className="text-port-accent animate-pulse">●</span>
                    )}
                    {!stage.isCurrent && !stage.completed && (
                      <span className="text-gray-600">○</span>
                    )}
                    {stage.name}
                  </button>
                );
              })}
            </div>
          )}
          {/* Output content: show stage-specific output for pipeline agents */}
          {(() => {
            // For pipeline agents viewing a prior stage
            const activeStage = pipelineStages?.[activeStageTab];
            if (activeStage && !activeStage.isCurrent && activeStage.agentId) {
              const stageOut = stageOutputs[activeStage.agentId];
              if (loadingStageId === activeStage.agentId) {
                return (
                  <div className="flex items-center gap-2 text-gray-500 text-sm">
                    <Loader2 size={14} aria-hidden="true" className="animate-spin" />
                    Loading stage output...
                  </div>
                );
              }
              // A truncated transcript whose tail window yielded no renderable
              // lines still has to say so — falling through to "No output
              // captured" would call a multi-MB log empty.
              if (stageOut?.lines.length > 0 || stageOut?.truncated) {
                return (
                  <>
                    <TranscriptTruncationNotice transcript={stageOut} />
                    {stageOut.lines.length > 0 && <OutputBlocks key={activeStage.agentId} output={stageOut.lines} />}
                  </>
                );
              }
              return <div className="text-gray-500 text-sm">No output captured for this stage</div>;
            }
            // For pipeline agents viewing a future stage (not yet run)
            if (activeStage && !activeStage.isCurrent && !activeStage.agentId) {
              return <div className="text-gray-500 text-sm">This stage has not run yet</div>;
            }
            // Current stage or non-pipeline agent: existing behavior
            if (loadingOutput) {
              return (
                <div className="flex items-center gap-2 text-gray-500 text-sm">
                  <Loader2 size={14} aria-hidden="true" className="animate-spin" />
                  Loading full output...
                </div>
              );
            }
            const truncated = inactive && fullOutput?.truncated;
            if (output.length > 0 || truncated) {
              return (
                <>
                  {truncated && <TranscriptTruncationNotice transcript={fullOutput} />}
                  {output.length > 0 && <OutputBlocks output={output} />}
                </>
              );
            }
            return <div className="text-gray-500 text-sm">No output captured</div>;
          })()}
        </div>
      )}
      <Modal
        open={promptOpen}
        onClose={() => setPromptOpen(false)}
        size="2xl"
        usePortal
        panelClassName="bg-port-card border border-port-border rounded-lg flex flex-col"
        ariaLabel="Agent prompt"
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-port-border shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare size={14} className="text-gray-400" aria-hidden="true" />
            <span className="text-sm text-gray-300">Agent prompt</span>
            {promptContent && (
              <span className="text-xs text-gray-500 font-mono">
                {promptContent.length.toLocaleString()} chars · {promptContent.split('\n').length} lines
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {promptContent && (
              <button
                onClick={copyPromptToClipboard}
                className="text-xs px-2 py-1 rounded bg-port-border/40 text-gray-400 hover:text-white"
              >
                Copy
              </button>
            )}
            <button
              onClick={() => setPromptOpen(false)}
              className="text-xs px-2 py-1 rounded bg-port-border/40 text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Close prompt viewer"
            >
              Close
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {loadingPrompt && (
            <div className="flex items-center gap-2 text-gray-500 text-sm">
              <Loader2 size={14} aria-hidden="true" className="animate-spin" />
              Loading prompt…
            </div>
          )}
          {promptError && (
            <div className="text-port-error text-sm">{promptError}</div>
          )}
          {!loadingPrompt && !promptError && promptContent != null && (
            <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words">{promptContent}</pre>
          )}
        </div>
      </Modal>
    </div>
  );
}
