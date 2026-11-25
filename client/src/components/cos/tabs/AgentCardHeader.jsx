import { useState } from 'react';
import { Link } from 'react-router';
import { Copy, Cpu, Loader2, Pause, RefreshCw, RotateCcw, Skull, Trash2 } from 'lucide-react';
import ExecutionOptionsAttribution from '../../providers/ExecutionOptionsAttribution.jsx';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { copyToClipboard } from '../../../lib/clipboard';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';
import { runPath, runEventsPath, taskPath } from '../crossLinks.js';
import { shortClaudeModelName } from '../../../utils/formatters';

export default function AgentCardHeader({ agent, inactive, isSystemAgent, remote, peerName, paused, controls }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1 mb-2">
      {/* Wrap actions before they squeeze the identity into a narrow column. */}
      <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1 basis-64">
        <Cpu size={16} aria-hidden="true" className={`shrink-0 ${inactive ? 'text-gray-500' : 'text-port-accent animate-pulse'}`} />
        <span className="font-mono text-sm text-gray-400 truncate min-w-0">{agent.id}</span>
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
        {!remote && agent.metadata?.runId && (
          <>
            <Link to={runPath(agent.metadata.runId)} onClick={(event) => event.stopPropagation()}
              className="inline-flex min-h-[44px] items-center px-1 text-xs text-port-accent hover:underline shrink-0">Run</Link>
            <Link to={runEventsPath(agent.metadata.runId)} onClick={(event) => event.stopPropagation()}
              className="inline-flex min-h-[44px] items-center px-1 text-xs text-port-accent hover:underline shrink-0">Events</Link>
          </>
        )}
        {!remote && agent.taskId && (
          <Link to={taskPath(agent.taskId)} onClick={(event) => event.stopPropagation()}
            className="inline-flex min-h-[44px] items-center px-1 text-xs text-port-accent hover:underline shrink-0">Task</Link>
        )}
        {remote && peerName && (
          <span className="px-1.5 py-0.5 text-xs bg-port-accent/20 text-port-accent rounded min-w-0 max-w-full [overflow-wrap:anywhere]" title={`Remote agent on ${peerName}`}>
            {peerName}
          </span>
        )}
        {agent.metadata?.taskApp && (agent.metadata.taskAppName || agent.metadata.workspaceName) && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(agent.metadata.taskAppName || agent.metadata.workspaceName) && (
          <span className="px-1.5 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 rounded min-w-0 max-w-full [overflow-wrap:anywhere]" title={agent.metadata.workspacePath || agent.metadata.taskApp}>
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
        {agent.metadata?.taskQuotaBurnMaintenanceRunId ? (
          <span className="px-1.5 py-0.5 text-xs bg-blue-500/20 text-blue-300 rounded" title={`Maintenance run ${agent.metadata.taskQuotaBurnMaintenanceRunId}`}>
            Maintenance run
          </span>
        ) : agent.metadata?.taskQuotaBurnFamily ? (
          <span className="px-1.5 py-0.5 text-xs bg-orange-500/20 text-orange-300 rounded" title={`Quota burn: ${agent.metadata.taskQuotaBurnFamily}`}>
            Quota burn
          </span>
        ) : null}
        {/* This run took over a paused/relaunched one. The predecessor's card
            says it handed off; this is the other half of that pair. */}
        {agent.metadata?.resumedFromAgentId && (
          <Link
            to={`/cos/agents/${agent.metadata.resumedFromAgentId}`}
            onClick={(event) => event.stopPropagation()}
            className="px-1.5 py-0.5 text-xs bg-port-accent/20 text-port-accent rounded shrink-0 inline-flex items-center gap-1 hover:bg-port-accent/30 transition-colors"
            title={`Continues agent ${agent.metadata.resumedFromAgentId}`}
          >
            <RotateCcw size={11} aria-hidden="true" />
            Continues {agent.metadata.resumedFromAgentId.slice(0, 8)}
          </Link>
        )}
        {agent.metadata?.model && (
          <span className={`px-2 py-0.5 text-xs rounded min-w-0 max-w-full break-words ${
            ['heavy', 'ultra'].includes(agent.metadata.modelTier) ? 'bg-purple-500/20 text-purple-400' :
            agent.metadata.modelTier === 'light' ? 'bg-green-500/20 text-green-400' :
            'bg-blue-500/20 text-blue-400'
          }`} title={agent.metadata.modelReason}>
            {shortClaudeModelName(agent.metadata.model)}
          </span>
        )}
        <ExecutionOptionsAttribution value={agent.metadata?.executionOptions} compact />
        {!inactive && (
          // 'stalled' is the one phase that does NOT pulse: the run is still
          // alive but has ignored every nudge, and an animated badge reads as
          // progress. See the stall gate in server/services/agent/agentTuiSpawning.js.
          <span className={`px-2 py-0.5 text-xs rounded shrink-0 ${
            agent.metadata?.phase === 'stalled' ? 'bg-orange-500/20 text-orange-400' :
            agent.metadata?.phase === 'initializing' ? 'bg-yellow-500/20 text-yellow-400 animate-pulse' :
            'bg-port-accent/20 text-port-accent animate-pulse'
          }`} title={agent.metadata?.phase === 'stalled'
            ? 'Idle and not responding to nudges — open the Shell tab to take it over'
            : undefined}>
            {agent.metadata?.phase === 'stalled' ? 'Stalled'
                : agent.metadata?.phase === 'initializing' ? 'Initializing'
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
      <AgentControlBar agent={agent} inactive={inactive} paused={paused} {...controls} />
    </div>
  );
}

function AgentControlBar({ agent, inactive, paused, completed, remote, hasOutput, expanded, setExpanded, onRelaunch, onPause, onKill, onResume, onDelete }) {
  const [pausing, setPausing] = useState(false);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const [killing, setKilling] = useState(false);
  const [confirmingKill, setConfirmingKill] = useState(false);

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

  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full ml-0 sm:ml-auto">
      {(hasOutput || inactive || !remote) && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="min-h-[44px] min-w-[44px] justify-center px-2 text-gray-500 hover:text-white transition-colors text-xs whitespace-nowrap"
          aria-expanded={expanded}
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      )}
      {!inactive && onRelaunch && (
        <button
          onClick={() => onRelaunch(agent)}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
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
          className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 px-2 py-1 text-xs rounded bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors disabled:opacity-50"
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
            className="flex-wrap max-w-full"
            largeTouchTargets
            confirmText="Kill"
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
            className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 px-2 py-1 text-xs rounded bg-port-error/20 text-port-error hover:bg-port-error/30 transition-colors disabled:opacity-50"
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
          className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
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
            className="flex-wrap max-w-full"
            largeTouchTargets
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
  );
}
