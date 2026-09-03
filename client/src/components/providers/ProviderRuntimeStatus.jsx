/**
 * Per-provider runtime install status + call to action.
 *
 * A CLI/TUI provider is dead weight until its binary is on PortOS's PATH, and
 * an API provider fronted by a local app (LM Studio, Ollama) is dead until that
 * app is installed. This is the small badge-sized widget every provider card
 * renders for its runtime — replacing the full-width OpenCode-only install bar
 * that used to sit at the top of the page, so the affordance lives next to the
 * provider it belongs to and every installable runtime gets the same treatment.
 *
 * `runtime` is `{ id, label, installed, installable, blockedReason, docsUrl,
 * manageUrl }` — an entry of the `runtimes` map from
 * `GET /api/providers/runtimes` for a CLI provider, or the local-app shape the
 * page derives from the local-LLM status. Renders nothing without one, so a
 * command PortOS has no installer for (and a card drawn before the fetch
 * resolves) shows no install UI at all.
 *
 * `manageUrl` means "PortOS installs this from another screen" — the Local LLM
 * tab owns Ollama/LM Studio, service start-up included — so that case links
 * there rather than duplicating the flow.
 */

import { Link } from 'react-router';
import { CheckCircle2, Download, ExternalLink } from 'lucide-react';
import Pill from '../ui/Pill';

const ACTION_CLASS = 'inline-flex items-center gap-1 px-2 py-1 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors';

/**
 * `optional` — the provider is switched off, so a missing binary is a note on
 * what enabling it would take, not a gap in the install (see
 * `providerCardState`): the badge drops to the muted tone. The install button
 * stays — it is still the one click that makes the provider usable.
 */
export default function ProviderRuntimeStatus({ runtime, onInstall, optional = false, className = '' }) {
  if (!runtime) return null;
  const { label, command, installed, installable, blockedReason, docsUrl, manageUrl, version } = runtime;

  if (installed) {
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className}`}>
        <Pill tone="success" size="xs" icon={CheckCircle2} title={command ? `PortOS can run \`${command}\`.` : undefined}>
          {label} installed{version ? ` · ${version}` : ''}
        </Pill>
        {/* A card can say WHICH version is here, but not whether it is current or
            how to move it — that needs the registry read and the lifecycle
            actions the Harnesses page owns. Local-app runtimes keep their own
            `manageUrl` (Models → LLMs). */}
        {!manageUrl && (
          <Link to="/models/harnesses" className="text-[11px] text-gray-500 hover:text-port-accent">
            Manage harness
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${className}`}>
      <Pill tone={optional ? 'muted' : 'warning'} size="xs">{label} not installed</Pill>
      {installable ? (
        <button
          type="button"
          onClick={() => onInstall?.(runtime)}
          className={ACTION_CLASS}
          title={`Install ${label} on this host`}
        >
          <Download size={12} />
          Install {label}
        </button>
      ) : manageUrl ? (
        <Link to={manageUrl} className={ACTION_CLASS} title={`Install ${label} from Models → LLMs`}>
          <Download size={12} />
          Install {label}
        </Link>
      ) : docsUrl && (
        // PortOS can't run this install here — the vendor's own instructions are
        // the only way forward, so offer them rather than a dead button.
        <a href={docsUrl} target="_blank" rel="noreferrer" className={ACTION_CLASS}>
          Install instructions
          <ExternalLink size={11} />
        </a>
      )}
      {!installable && blockedReason && <span className="text-gray-400">{blockedReason}</span>}
    </div>
  );
}
