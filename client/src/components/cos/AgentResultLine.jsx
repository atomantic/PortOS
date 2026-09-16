import { CheckCircle, AlertCircle, RotateCcw } from 'lucide-react';
import { isAgentHandoff, agentHandoffReason } from '../../lib/agentOutcome';

/**
 * The one-line verdict on a finished agent run — THREE outcomes, not two.
 *
 * A run retired by Resume/Relaunch carries `success: false` because it never
 * reached a verdict: its task was handed to a continuation, usually because the
 * user swapped providers after hitting a usage limit. Rendering that red said the
 * run failed, for something the user did on purpose.
 *
 * Shared by the run card and the Resume dialog. They had the same two-way ternary
 * copy-pasted, so going from two states to three meant editing both — and the
 * copies had already drifted on the fallback text. One component instead, so the
 * next state costs one edit and the two surfaces cannot disagree about what the
 * same record says.
 */
export default function AgentResultLine({ agent, className = '' }) {
  if (!agent?.result) return null;
  const handoff = isAgentHandoff(agent);
  const tone = handoff ? 'text-port-accent' : agent.result.success ? 'text-port-success' : 'text-port-error';

  return (
    <div className={`text-sm flex items-center gap-2 ${tone} ${className}`.trim()}>
      {handoff ? (
        <><RotateCcw size={14} aria-hidden="true" /> {agentHandoffReason(agent)}</>
      ) : agent.result.success ? (
        <><CheckCircle size={14} aria-hidden="true" /> Completed successfully</>
      ) : (
        <><AlertCircle size={14} aria-hidden="true" /> {agent.result.error || 'Failed'}</>
      )}
    </div>
  );
}
