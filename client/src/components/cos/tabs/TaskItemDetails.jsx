import { GITHUB_WORKFLOW_SCOPE_REMEDY, isGitHubWorkflowScopeBlock } from '../../../../../server/lib/agent/agentOutcome.js';
import { AlertCircle, Ban, CheckCircle, ExternalLink, FileText, Paperclip, Scale } from 'lucide-react';
import { formatBytes } from '../../../utils/formatters';
import CollapsibleText from '../../ui/CollapsibleText';
import PreflightProgress from './PreflightProgress';
import BlockedSystemRecovery from '../BlockedSystemRecovery';
import { ReleasePublicationLine } from '../AgentResultLine';


const approvalDetailsReason = metadata => {
  const outcome = metadata.taskOutcome;
  const options = outcome?.recovery?.options;
  const generated = typeof outcome?.reason === 'string' && Array.isArray(options)
    ? `${outcome.reason}\nApproval required before proceeding.\nOptions:\n${options.map((option, index) => `${index + 1}. ${option}`).join('\n')}` : null;
  return generated !== null && metadata.blockedReason === generated ? outcome.reason : metadata.blockedReason || outcome?.reason;
};

function SecurityScanReport({ scan, idScope, taskId }) {
  const reports = Array.isArray(scan?.reports) ? scan.reports : [];
  if (!reports.length || !['findings', 'unavailable'].includes(scan?.status)) return null;
  const incomplete = scan.status === 'unavailable';

  return (
    <section
      className="mt-2 px-2 py-2 bg-port-error/10 border border-port-error/20 rounded text-sm"
      aria-label="Security scan report"
    >
      <div className="flex items-center gap-2 text-port-error/90">
        <AlertCircle size={14} aria-hidden="true" />
        <span className="font-medium">{incomplete ? 'Security scan report' : 'Security scan findings'}</span>
        <span className="text-xs text-gray-400">read-only report · no PR actions taken</span>
      </div>
      <p className="mt-1 text-xs text-gray-400">
        {incomplete
          ? 'Stage 1 could not complete safely. Any collected report remains human-only and no PR actions have been taken.'
          : 'Stage 1 flagged possible model-abuse content. The flagged diff and report are withheld from the Stage 2 model; no PR actions have been taken.'}
      </p>
      <div className="space-y-2 mt-2">
        {reports.map((report) => {
          const number = String(report?.number ?? 'unknown');
          const url = typeof report?.url === 'string' && /^https?:\/\//i.test(report.url) ? report.url : null;
          return (
            <div key={`${taskId}-security-report-${number}`} className="pl-2 border-l border-port-error/30">
              <div className="flex items-center gap-2 flex-wrap text-xs text-gray-300">
                <span className="font-medium">PR #{number}</span>
                {url && (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-port-accent hover:text-port-accent/80"
                  >
                    Open PR
                  </a>
                )}
                {report?.passed === true && <span className="text-port-success">clean</span>}
              </div>
              <CollapsibleText
                id={`security-report-${idScope}-${taskId}-${number}`}
                text={typeof report?.findings === 'string' && report.findings ? report.findings : 'No findings.'}
                className="mt-1 text-gray-300 whitespace-pre-wrap"
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TaskItemBlocker({ task, idScope }) {
  return (
    <>
      {isGitHubWorkflowScopeBlock(task) && (
        <section className="mt-2 space-y-1 rounded border border-port-warning/30 p-2 text-sm" aria-label="GitHub workflow access">
          <p className="font-medium text-port-warning">GitHub workflow access required</p>
          <p>Repository ownership does not grant the GitHub CLI credential permission to write workflow files.</p>
          <p>On the instance that ran this task, open a normal terminal and use the GitHub CLI account assigned to the project. For GitHub.com OAuth, run:</p>
          <code className="block select-all break-words rounded bg-port-bg px-2 py-1">{GITHUB_WORKFLOW_SCOPE_REMEDY}</code>
          <p>If the CLI says it is using <code>GH_TOKEN</code> or <code>GITHUB_TOKEN</code>, use a terminal without those overrides for the refresh. The refresh updates the stored login, not an injected token.</p>
          <p>Approve the GitHub prompt, then select <strong>Unblock</strong> to retry the retained work. If the project uses a different credential, update that credential instead.</p>
        </section>
      )}
      {/* Blocker reason display. Prefer the user-set `blocker`, but fall
          back to `blockedReason` — the field every server-side block
          writes (max-spawns, retries, provider-config, terminated, …), so
          without this fallback an auto-blocked task shows no reason at all. */}
      {task.status === 'blocked' && !task.metadata?.blocker
        && task.metadata?.blockedInvestigation?.sourceCategory === task.metadata?.blockedCategory
        && task.metadata?.blockedInvestigation?.sourceBlockedAt === (task.metadata?.blockedAt || task.metadata?.lastSpawnedAt || 'legacy') ? <div className="mt-2">
        <BlockedSystemRecovery recovery={task.metadata.blockedInvestigation} />
        {task.metadata.blockedCategory === 'task-approval' && <div className="mt-1 text-sm text-port-error/90">
          <p className="font-medium">Approval is still required.</p>
          {approvalDetailsReason(task.metadata) && <CollapsibleText
            id={`task-blocker-${idScope}-${task.id}`}
            text={approvalDetailsReason(task.metadata)}
            className="text-port-error/90"
          />}
          {Array.isArray(task.metadata.taskOutcome?.recovery?.options) && <ol className="list-decimal pl-5">
            {task.metadata.taskOutcome.recovery.options.map((option, index) => <li key={`${index}-${option}`}>{option}</li>)}
          </ol>}
        </div>}
        {task.metadata.blockedCategory !== 'task-approval' && task.metadata.blockedReason && <details className="mt-1">
          <summary className="cursor-pointer text-sm text-port-text-muted">Original failure details</summary>
          <CollapsibleText id={`task-blocker-${idScope}-${task.id}`} text={task.metadata.blockedReason} className="text-port-error/90" />
        </details>}
      </div> : task.status === 'blocked' && (task.metadata?.blocker || task.metadata?.blockedReason) && (
        <div className="flex items-start gap-2 mt-2 px-2 py-1.5 bg-port-error/10 border border-port-error/20 rounded text-sm">
          <AlertCircle size={14} className="text-port-error shrink-0 mt-0.5" aria-hidden="true" />
          {/* Clamped: server-side auto-blocks write `blockedReason` from
              LLM error analysis / raw stderr, which can run very long. */}
          <div className="min-w-0 flex-1">
            <CollapsibleText
              id={`task-blocker-${idScope}-${task.id}`}
              text={task.metadata.blocker || task.metadata.blockedReason}
              className="text-port-error/90"
            />
          </div>
        </div>
      )}
    </>
  );
}

export default function TaskItemDetails({ task, idScope, unconfirmed, handleResolveChallenge, resolvingChallenge }) {
  return (
    <>
      <CollapsibleText
        id={`task-desc-${idScope}-${task.id}`}
        text={task.description}
        className="text-white"
      />
      {/* The prompt runs to hundreds of lines for orchestrator tasks, so
          it gets the same clamp as the description — an unclamped one
          turns the pending list into a wall of text the user has to
          scroll past. The note below it gets the same treatment, since a
          legacy task still carries its payload there. */}
      {task.metadata?.prompt && (
        <CollapsibleText
          id={`task-prompt-${idScope}-${task.id}`}
          text={task.metadata.prompt}
          className="text-sm text-gray-500 mt-1"
        />
      )}
      {task.metadata?.context && (
        <CollapsibleText
          id={`task-context-${idScope}-${task.id}`}
          text={task.metadata.context}
          className="text-sm text-gray-500 mt-1"
        />
      )}
      <PreflightProgress
        preflight={task.metadata?.preflight}
        active={task.preflightActive === true}
        unconfirmed={Boolean(unconfirmed)}
        idScope={idScope}
        taskId={task.id}
      />
      <SecurityScanReport
        scan={task.metadata?.pipeline?.securityScan}
        idScope={idScope}
        taskId={task.id}
      />
      {(task.metadata?.releasePublication || task.metadata?.releaseSynchronization) && (
        <ReleasePublicationLine
          publication={task.metadata?.releasePublication}
          synchronization={task.metadata?.releaseSynchronization}
          className="mt-2"
        />
      )}
      {(task.metadata?.model || task.metadata?.provider || task.metadata?.effort) && (
        <div className="flex flex-wrap items-center gap-2 mt-1">
          {task.metadata?.model && (
            <span className="px-1.5 py-0.5 text-xs bg-port-accent-2/20 text-port-accent-2 rounded font-mono">
              {task.metadata.model}
            </span>
          )}
          {task.metadata?.provider && (
            <span className="px-1.5 py-0.5 text-xs bg-port-accent/20 text-port-accent rounded">
              {task.metadata.provider}
            </span>
          )}
          {task.metadata?.effort && (
            <span className="px-1.5 py-0.5 text-xs bg-port-warning/20 text-port-warning rounded">
              {task.metadata.effort} effort
            </span>
          )}
        </div>
      )}
      {/* Attachments display */}
      {task.metadata?.attachments?.length > 0 && (
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <Paperclip size={12} className="text-gray-500" aria-hidden="true" />
          {task.metadata.attachments.map((att, idx) => (
            <a
              key={idx}
              href={`/api/attachments/${encodeURIComponent(att.filename)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2 py-0.5 text-xs bg-port-accent/10 text-port-accent hover:bg-port-accent/20 rounded transition-colors"
              title={`${att.originalName || att.filename}${att.size ? ` (${formatBytes(att.size)})` : ''}`}
            >
              <FileText size={10} aria-hidden="true" />
              <span className="truncate max-w-[100px]">{att.originalName || att.filename}</span>
              <ExternalLink size={10} aria-hidden="true" />
            </a>
          ))}
        </div>
      )}
      <TaskItemBlocker task={task} idScope={idScope} />
      {/* Challenge case + resolution (#2441). Both sides of a disputed
          rejection are logged on the task metadata so the outcome is
          auditable here: the worker's case while parked in `challenged`,
          and the resolver's verdict once it settles. */}
      {task.metadata?.challenge?.reason && (
        <div className="flex items-start gap-2 mt-2 px-2 py-1.5 bg-port-warning/10 border border-port-warning/20 rounded text-sm">
          <Scale size={14} className="text-port-warning shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-port-warning/90 min-w-0">
            <span className="font-medium">Challenge{task.metadata.challenge.reviewer ? ` (${task.metadata.challenge.reviewer})` : ''}:</span>
            {/* Clamped: the reason is free text a worker agent writes to
                argue its case, so multi-paragraph is the expected shape. */}
            <CollapsibleText
              id={`task-challenge-${idScope}-${task.id}`}
              text={task.metadata.challenge.reason}
            />
            {task.metadata.challengeResolution?.outcome && (
              <div className="mt-1 text-gray-400">
                Resolved: {task.metadata.challengeResolution.outcome}
                {task.metadata.challengeResolution.note ? ` — ${task.metadata.challengeResolution.note}` : ''}
              </div>
            )}
            {/* Inline resolve controls while parked in `challenged` and not
                yet settled (#2471) — Uphold overturns the rejection and
                re-queues the work, Escalate surfaces it for arbitration. */}
            {task.status === 'challenged' && !task.metadata.challengeResolution?.outcome && (
              <div className="flex items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => handleResolveChallenge('upheld')}
                  disabled={resolvingChallenge}
                  className="flex items-center gap-1 px-2.5 py-1 min-h-[32px] text-xs text-port-success bg-port-success/10 hover:bg-port-success/20 rounded transition-colors disabled:opacity-50"
                  title="Overturn the rejection and re-queue this task"
                >
                  <CheckCircle size={12} aria-hidden="true" /> Uphold
                </button>
                <button
                  type="button"
                  onClick={() => handleResolveChallenge('escalated')}
                  disabled={resolvingChallenge}
                  className="flex items-center gap-1 px-2.5 py-1 min-h-[32px] text-xs text-port-error bg-port-error/10 hover:bg-port-error/20 rounded transition-colors disabled:opacity-50"
                  title="Let the rejection stand and file an arbitration task"
                >
                  <Ban size={12} aria-hidden="true" /> Escalate
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
