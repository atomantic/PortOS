import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { formatBytes, formatCount } from '../../../utils/formatters';
import ListLoadError from '../../ui/ListLoadError';
import MarkdownOutput from '../MarkdownOutput';
import OutputBlocks from '../OutputBlocks';

function TranscriptTruncationNotice({ transcript }) {
  if (!transcript?.truncated) return null;
  const count = transcript.lines.length;
  const size = transcript.totalBytes > 0 ? ` (${formatBytes(transcript.totalBytes)})` : '';
  return (
    <div className="flex items-center gap-1.5 text-xs text-yellow-500 mb-2">
      <AlertTriangle size={12} aria-hidden="true" className="shrink-0" />
      <span>
        {count > 0
          ? `Showing the last ${formatCount(count)} ${count === 1 ? 'line' : 'lines'} — the full transcript${size} is on disk in the agent's output.txt.`
          : `The tail of this transcript held no readable lines — the full transcript${size} is on disk in the agent's output.txt.`}
      </span>
    </div>
  );
}

export default function AgentTranscriptPanel({ agent, completed, inactive, remote, cleanupTracked, linkifyIssues, transcript }) {
  const {
    outputPanelRef, taskSummary, fullMetadata, loadingOutput, reloadOutput, setExpanded,
    transcriptExpanded, setTranscriptExpanded, pipelineStages, activeStageTab, setActiveStageTab,
  } = transcript;

  return (
    <div ref={outputPanelRef} className="border-t border-port-border bg-port-bg/50 p-3 min-w-0 overflow-y-auto max-h-dvh-cap [--dvh-cap:60dvh]">
      {taskSummary && (
        <div className="mt-2 bg-port-bg/50 border border-port-border/50 rounded p-2.5">
          <div className="text-[11px] text-gray-500 mb-1 flex items-center gap-1">
            <Sparkles size={10} aria-hidden="true" className="text-emerald-400" />
            {cleanupTracked ? 'Earlier agent report — current delivery and cleanup status shown above' : 'Task Summary'}
          </div>
          {taskSummary && <MarkdownOutput content={taskSummary} linkifyText={linkifyIssues} />}
          {agent.metadata?.taskSummaryTruncated && !fullMetadata?.taskSummary && (
            <p className="mt-1 text-xs text-port-text-muted">
              Summary preview. {!remote && <button type="button" className="text-port-accent hover:underline" disabled={loadingOutput}
                onClick={() => { reloadOutput(); setExpanded(true); }}>Load full summary</button>}
            </p>
          )}

        </div>
      )}

      {completed && !taskSummary && (
        <p className="text-sm text-port-text-muted">
          {loadingOutput ? 'Loading completion summary…' : 'No completion summary was saved. The runner transcript is available separately.'}
        </p>
      )}
      {(completed || taskSummary) && (
        <button type="button" className="mt-2 text-xs text-port-accent hover:underline"
          aria-expanded={transcriptExpanded} onClick={() => setTranscriptExpanded(value => !value)}>
          {transcriptExpanded ? 'Hide full transcript' : 'Show full transcript'}
        </button>
      )}
      {((!completed && !taskSummary) || transcriptExpanded) && <>
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
        <TranscriptOutput transcript={transcript} inactive={inactive} linkifyIssues={linkifyIssues} />
      </>}
    </div>
  );
}

function TranscriptOutput({ transcript, inactive, linkifyIssues }) {
  const {
    pipelineStages, activeStageTab, stageOutputs, loadingStageIds, stageErrors,
    fetchStageOutput, loadingOutput, outputError, reloadOutput, fullOutput, output,
  } = transcript;
  // For pipeline agents viewing a prior stage
  const activeStage = pipelineStages?.[activeStageTab];
  if (activeStage && !activeStage.isCurrent && activeStage.agentId) {
    const stageOut = stageOutputs[activeStage.agentId];
    if (loadingStageIds.has(activeStage.agentId)) {
      return (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 size={14} aria-hidden="true" className="animate-spin" />
          Loading stage output...
        </div>
      );
    }
    if (stageErrors[activeStage.agentId]) {
      return (
        <ListLoadError
          what="this stage's output"
          error={{ message: stageErrors[activeStage.agentId] }}
          onRetry={() => fetchStageOutput(activeStage.agentId)}
        />
      );
    }
    // A truncated transcript whose tail window yielded no renderable
    // lines still has to say so — falling through to "No output
    // captured" would call a multi-MB log empty.
    if (stageOut?.lines.length > 0 || stageOut?.truncated) {
      return (
        <>
          <TranscriptTruncationNotice transcript={stageOut} />
          {stageOut.lines.length > 0 && <OutputBlocks key={activeStage.agentId} output={stageOut.lines} linkifyText={linkifyIssues} />}
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
  if (inactive && outputError) {
    return <ListLoadError what="the transcript" error={{ message: outputError }} onRetry={reloadOutput} />;
  }
  const truncated = inactive && fullOutput?.truncated;
  if (output.length > 0 || truncated) {
    return (
      <>
        {truncated && <TranscriptTruncationNotice transcript={fullOutput} />}
        {output.length > 0 && <OutputBlocks output={output} linkifyText={linkifyIssues} anchor={inactive ? 'head' : 'tail'} />}
      </>
    );
  }
  return <div className="text-gray-500 text-sm">No output captured</div>;
}
