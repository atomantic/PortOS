import { Network } from 'lucide-react';
import { hardwareUnavailableReason } from '../../utils/systemCapabilities';
import { isProcessProvider, providerTypeClass } from '../../utils/providerTypes';
import { PROVIDER_CARD_STATE, isRunnerAllowedCommand } from '../../utils/providerReadiness';
import ProviderRuntimeBadge from './ProviderRuntimeBadge';

// One phrasing for "this command isn't on the CoS Agent Runner's allowlist".
// The editor states the same thing in its own inline banner, in prose.
const RUNNER_NOT_ALLOWED_HINT = 'This command is not on the CoS Agent Runner’s allowlist, so /spawn and /spawn-tui will refuse it. The provider still works everywhere else (direct spawn, chat, pipeline). The allowlist is curated in the PortOS source, not in this form.';

export default function ProviderCardHeader({
  provider,
  displayName,
  unified,
  isCardDefault,
  fleetHostLabel,
  runtimeBadge,
  cardState,
  status,
  style,
  optional,
  runnerAllowedCommands,
  codexQuotaExhausted,
  hardwareCompatible,
}) {
  const missingSummary = cardState.missing.map(m => m.label).join(' · ');
  const quotaHint = codexQuotaExhausted ? 'ChatGPT usage limit reached — calls route to the fallback.' : '';
  const reason = status?.reason || (codexQuotaExhausted ? 'usage-limit' : '');
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <h2 className="text-lg font-semibold text-white">{displayName}</h2>
      <span className={`text-xs px-2 py-0.5 rounded ${providerTypeClass(provider.type)}`}>
        {unified ? 'CLI / TUI' : provider.type.toUpperCase()}
      </span>
      {isCardDefault && (
        <span className="text-xs px-2 py-0.5 rounded bg-port-accent/20 text-port-accent">
          DEFAULT{unified ? ` · ${provider.type.toUpperCase()}` : ''}
        </span>
      )}
      {fleetHostLabel && (
        <span
          className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
          title={`Runs on ${fleetHostLabel}`}
        >
          <Network size={11} /> FLEET HOST
        </span>
      )}
      <ProviderRuntimeBadge meta={runtimeBadge} />
      {/* One badge for the card's state — the same one that
          colors its border and decides which section it sits in.
          BENCHED covers what used to render as UNAVAILABLE: an
          enabled provider sidelined after a failure (usage limit,
          model-not-found, auth) in favor of its fallback. */}
      <span
        className={`text-xs px-2 py-0.5 rounded ${style.badge}`}
        title={cardState.state === PROVIDER_CARD_STATE.BLOCKED
          ? missingSummary
          : (status?.message || quotaHint || style.hint)}
      >
        {style.label}
        {cardState.state === PROVIDER_CARD_STATE.BENCHED && reason ? ` · ${reason}` : ''}
      </span>
      {/* A switched-off provider that would also need a CLI or a key says
          so — wearing the DISABLED badge's own colors, because it is an FYI
          for the day the user wants it, not a task this install is behind on. */}
      {optional && missingSummary && (
        <span
          className={`text-xs px-2 py-0.5 rounded ${style.badge}`}
          title={`To enable: ${missingSummary}`}
        >
          SETUP TO ENABLE
        </span>
      )}
      {/* Off the CoS Agent Runner's exec allowlist: the provider still
          works for direct spawn, it just can't be launched by /spawn
          or /spawn-tui. Informational — never a save-time rejection. */}
      {isProcessProvider(provider) && isRunnerAllowedCommand(provider.command, runnerAllowedCommands) === false && (
        <span
          className="text-xs px-2 py-0.5 rounded bg-port-warning/20 text-port-warning"
          title={RUNNER_NOT_ALLOWED_HINT}
        >
          NO AGENT RUNNER
        </span>
      )}
      {!hardwareCompatible && (
        <span
          className="text-xs px-2 py-0.5 rounded bg-port-warning/20 text-port-warning"
          title={hardwareUnavailableReason('This provider', provider.hardwareCompatibility)}
        >
          HARDWARE MISMATCH
        </span>
      )}
    </div>
  );
}
