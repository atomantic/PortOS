import { Eye, GitBranch, GitPullRequest, RefreshCw, Sparkles } from 'lucide-react';
import { DEFAULT_REVIEWER, normalizeReviewers } from '../constants';
import { harnessLabel, providerHarnessId } from '../../../utils/providerHarnesses';
import { isFalsyMeta, isTruthyMeta } from '../../../../../server/lib/metadataFlags.js';

// Every posture the agent-configuration badge row can render. Kept beside the row
// so adding a badge and widening its visibility guard is one edit, not two — a
// badge left out of this list silently never renders.
const CONFIG_BADGE_KEYS = [
  'configClaimFlow',
  'configUseWorktree',
  'configReadOnly',
  'configCodingOnMain',
  'configOpenPR',
  'configSimplify',
  'configReviewLoop',
];

const PROVIDER_BADGE_CLASSES = {
  provider: 'bg-blue-500/15 text-blue-400',
  harness: 'bg-cyan-500/15 text-cyan-400',
  service: 'bg-violet-500/15 text-violet-400',
  plan: 'bg-fuchsia-500/15 text-fuchsia-400',
  route: 'bg-slate-500/15 text-slate-300',
  command: 'bg-indigo-500/15 text-indigo-400',
  execution: 'bg-emerald-500/15 text-emerald-400',
  dispatch: 'bg-teal-500/15 text-teal-400',
  tier: 'bg-orange-500/15 text-orange-400',
  tierDowngraded: 'bg-red-500/15 text-red-400',
  prompt: 'bg-amber-500/15 text-amber-400',
  auth: 'bg-rose-500/15 text-rose-400',
};

function buildTierBadge(metadata) {
  const downgraded = metadata.modelDowngradedFromDefault;
  return {
    key: downgraded ? 'tierDowngraded' : 'tier',
    label: downgraded ? 'Tier (downgraded)' : 'Tier',
    value: metadata.modelTier,
    title: downgraded
      ? `Ran on "${metadata.model}" — the learning system substituted this for the configured default "${metadata.modelConfiguredDefault}" (${metadata.modelReason})`
      : metadata.modelReason ? `Model selection: ${metadata.modelReason}` : `Model tier ${metadata.modelTier}`,
  };
}

function buildProviderConfigBadges(metadata = {}) {
  const providerId = metadata.providerId || null;
  const providerType = metadata.providerType || null;
  const providerCommand = metadata.providerCommand || null;
  const inferredHarnessId = providerHarnessId({ id: providerId, type: providerType, command: providerCommand });
  const harnessId = metadata.harnessId ?? inferredHarnessId;
  const providerName = metadata.providerName || providerId;
  const providerMethod = metadata.providerMethod || providerType;
  const dispatch = isTruthyMeta(metadata.useRunner)
    ? 'Runner'
    : isFalsyMeta(metadata.useRunner) ? 'Server' : null;
  const isCredentialBootstrap = isTruthyMeta(metadata.providerHasCredentialBootstrap);
  const credentialBootstrap = metadata.providerCredentialBootstrapId || (isCredentialBootstrap ? 'bootstrap' : null);

  return [
    providerName && {
      key: 'provider',
      label: 'Provider',
      value: providerName,
      title: providerId && providerName !== providerId ? `Provider ${providerName} (${providerId})` : `Provider ${providerName}`,
    },
    harnessId && {
      key: 'harness',
      label: 'Harness',
      value: harnessLabel(harnessId),
      title: `Harness ${harnessId}`,
    },
    metadata.serviceId && {
      key: 'service',
      label: 'Service',
      value: metadata.serviceId,
      title: `Service ${metadata.serviceId}`,
    },
    metadata.servicePlan && {
      key: 'plan',
      label: 'Plan',
      value: metadata.servicePlan,
      title: `Service plan ${metadata.servicePlan}`,
    },
    providerMethod && {
      key: 'route',
      label: 'Route',
      value: providerMethod,
      title: `Provider route ${providerMethod}`,
    },
    providerCommand && {
      key: 'command',
      label: 'Command',
      value: providerCommand,
      title: `Provider command ${providerCommand}`,
    },
    metadata.executionMode && {
      key: 'execution',
      label: 'Execution',
      value: metadata.executionMode,
      title: `Execution mode ${metadata.executionMode}`,
    },
    dispatch && {
      key: 'dispatch',
      label: 'Dispatch',
      value: dispatch,
      title: `${dispatch}-owned child process`,
    },
    metadata.modelTier && buildTierBadge(metadata),
    metadata.leanMode && {
      key: 'prompt',
      label: 'Prompt',
      value: 'lean',
      title: 'Lean prompt mode',
    },
    credentialBootstrap && {
      key: 'auth',
      label: 'Auth',
      value: credentialBootstrap,
      title: credentialBootstrap === 'bootstrap'
        ? 'Credentials supplied by a bootstrap command'
        : `Credential bootstrap ${credentialBootstrap}`,
    },
  ].filter(Boolean);
}

export default function AgentConfigurationBadges({ agent }) {
  const providerConfigBadges = buildProviderConfigBadges(agent.metadata);

  return (
    <>
      {(providerConfigBadges.length > 0 || CONFIG_BADGE_KEYS.some(key => agent.metadata?.[key]) || agent.metadata?.effort) && (
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          {providerConfigBadges.map(({ key, label, value, title }) => (
            <span
              key={key}
              className={`flex items-center min-w-0 max-w-full [overflow-wrap:anywhere] px-1.5 py-0.5 text-[11px] rounded ${PROVIDER_BADGE_CLASSES[key]}`}
              title={title}
            >
              {label}: {value}
            </span>
          ))}
          {agent.metadata?.effort && (
            <span
              className="flex items-center px-1.5 py-0.5 text-[11px] rounded bg-orange-500/15 text-orange-400"
              title="Reasoning effort used for this invocation"
            >
              Effort: {agent.metadata.effort}
            </span>
          )}
          {/* A claim run self-manages its `claim/<item>` worktree and its own forge
              handoff, so CoS keeps configUseWorktree/configOpenPR off to avoid
              nesting a second worktree. Badge what it actually does rather than
              leaving the row bare — the CoS-managed badges cannot speak for it. */}
          {agent.metadata.configClaimFlow && !agent.metadata.configUseWorktree && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-teal-500/15 text-teal-400"
                  title="Claim flow — the agent cuts its own claim worktree and owns its forge handoff (PR or filed issue)">
              <GitBranch size={10} aria-hidden="true" />
              Claim WT
            </span>
          )}
          {agent.metadata.configUseWorktree && (
            <span className={`flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded ${
              agent.metadata.configWorktreeAutoDetected ? 'bg-orange-500/15 text-orange-400' : 'bg-teal-500/15 text-teal-400'
            }`} title={`Worktree: ${agent.metadata.worktreeBranch || 'unknown'}${agent.metadata.configWorktreeAutoDetected ? ' (auto-detected conflict)' : ''}`}>
              <GitBranch size={10} aria-hidden="true" />
              {agent.metadata.configWorktreeAutoDetected ? 'Auto-WT' : 'Worktree'}
            </span>
          )}
          {agent.metadata.configReadOnly && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-sky-500/15 text-sky-400"
                  title="Read-only run — inspects the checkout and commits nothing">
              <Eye size={10} aria-hidden="true" />
              Read-only
            </span>
          )}
          {/* Re-checked against the sibling postures on READ, not just at spawn:
              agents registered before those postures joined the projection have a
              stale configCodingOnMain frozen in their metadata, and an archived
              card must not warn "coding on main" over its own worktree badge. */}
          {agent.metadata.configCodingOnMain && !agent.metadata.configUseWorktree
            && !agent.metadata.configClaimFlow && !agent.metadata.configReadOnly && (
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
    </>
  );
}
