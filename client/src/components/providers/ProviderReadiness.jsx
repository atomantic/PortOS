/**
 * Local-daemon requirements checklist for one provider card.
 *
 * `ProviderRuntimeStatus` (its sibling) answers "is the CLI binary installed?".
 * This answers the other half for a provider backed by a local daemon: is
 * llama.cpp / Ollama / LM Studio / MTPLX installed, is it actually running at
 * the endpoint this provider points at, and is it serving the model this
 * provider asks for. Without it, a missing daemon or an un-downloaded model only
 * surfaced as `Cannot connect to API: Unable to connect` inside a dead agent
 * transcript.
 *
 * `readiness` is one entry of the map from `GET /api/providers/readiness`
 * (`{ kind, label, endpoint, ready, standby, checks, manageUrl, setup }`).
 * Renders nothing without one, so providers with no local dependency — and
 * cards drawn before the fetch resolves — show no checklist at all.
 *
 * Every unmet check is fixed from this banner: a one-click daemon setup
 * (`setup.action`), a "use the served model as default" button when the
 * running server answers under a different id, or an in-app Local LLM
 * settings link. Vendor setup docs are never the way forward.
 *
 * A model mismatch is fixable from BOTH ends, and the banner offers both.
 * llama.cpp serves one model per process and answers under the `--alias` on its
 * launch line, so a provider pinned to `qwen3.8-27b-dflash2` against a server
 * started as `dflash` is a naming mismatch, not a missing download — the user
 * can move the provider onto the served id, or press "Serve as …" to relaunch
 * the daemon on the weights it already has under the id they picked.
 *
 * That includes the case where the daemon is installed but nothing usable is on
 * disk: the server can't start, so `setup.action` is one of the PROVISIONING
 * actions and the button fetches what is missing before starting it — MTPLX's
 * default checkpoint (`pull-start`), or the whole vLLM compose project
 * (`provision-start`: clone, build, prepare). Offering a bare "Start" there was
 * a catch-22 — the start could only ever fail, and its error message was the
 * only place the missing payload was named.
 */

import { Link } from 'react-router';
import { CheckCircle2, Download, HelpCircle, PauseCircle, RefreshCw, Wand2, Wrench, XCircle } from 'lucide-react';
import Banner from '../ui/Banner';
import Pill from '../ui/Pill';


const ICONS = {
  true: { Icon: CheckCircle2, cls: 'text-port-success' },
  false: { Icon: XCircle, cls: 'text-port-error' },
  // `ok: null` — a check the server could not evaluate yet (the model list
  // cannot be read while the server is down). Shown as unknown rather than as a
  // failure, so the user chases the check that IS actionable.
  null: { Icon: HelpCircle, cls: 'text-gray-500' },
};

const ACTION_CLASS = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors font-medium';

/**
 * Render `text` with `backtick`-quoted spans as inline code. The server writes
 * check details in that shape so model ids and binary names read as literals
 * rather than as prose.
 */
function CodeText({ text }) {
  if (typeof text !== 'string' || text === '') return null;
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, i) => (
        i % 2 === 1
          ? <code key={i} className="text-gray-300 font-mono break-all">{part}</code>
          : <span key={i}>{part}</span>
      ))}
    </>
  );
}

/**
 * `optional` — the provider is switched off, so these checks are what enabling
 * it would take rather than an outstanding task (see `providerCardState`). Same
 * checks and same fix buttons, in an informational tone under a title saying so.
 */
export default function ProviderReadiness({ readiness, onAutoSetup, onUseServedModel, onServeWantedModel, serving = false, optional = false, className = '' }) {
  if (!readiness || !Array.isArray(readiness.checks) || readiness.checks.length === 0) return null;
  const { label, endpoint, ready, standby, standbyDetail, checks, manageUrl, setup } = readiness;

  if (ready) {
    return (
      <Pill tone="success" size="xs" icon={CheckCircle2} className={className} title={`${label} is running at ${endpoint}.`}>
        {label} ready
      </Pill>
    );
  }

  if (standby) {
    return (
      <Banner
        tone="info"
        size="sm"
        icon={PauseCircle}
        className={className}
        title={`${label} installed · standby`}
      >
        {standbyDetail && <p className="mt-1 text-gray-400"><CodeText text={standbyDetail} /></p>}
        {manageUrl && (
          <Link to={manageUrl} className={`${ACTION_CLASS} mt-2`}>Open the LLMs page</Link>
        )}
      </Banner>
    );
  }

  const blocked = checks.filter((check) => check.ok !== true).length;
  const requirements = `${blocked} requirement${blocked === 1 ? '' : 's'}`;

  return (
    <Banner
      tone={optional ? 'info' : 'warning'}
      size="sm"
      icon={Wrench}
      className={className}
      title={optional
        ? `${label} setup — ${requirements} to meet if you enable this provider`
        : `${label} setup incomplete — ${requirements} unmet`}
    >
      <ul className="space-y-1 mt-1">
        {checks.map((check) => {
          const { Icon, cls } = ICONS[String(check.ok)] || ICONS.null;
          return (
            <li key={check.id} className="flex items-start gap-1.5">
              <Icon size={12} className={`${cls} mt-0.5 shrink-0`} />
              <span className="text-gray-300 break-words">
                <CodeText text={check.label} />
                {check.detail && <span className="text-gray-500"> — <CodeText text={check.detail} /></span>}
                {check.fixHint && (
                  <span className={`block ${optional ? 'text-port-accent/90' : 'text-port-warning/90'}`}><CodeText text={check.fixHint} /></span>
                )}
                {check.id === 'model' && check.ok === false
                  && Array.isArray(check.servedModels) && check.servedModels.length > 0 && (
                  <span className="flex flex-wrap gap-1.5 mt-1.5">
                    {onUseServedModel && check.servedModels.slice(0, 3).map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onUseServedModel(id)}
                        className={ACTION_CLASS}
                        title={`Set this provider's default model to ${id} so it matches what ${label} is serving.`}
                      >
                        Use {id} as default
                      </button>
                    ))}
                    {/* The other direction: move the SERVER onto the id this
                        provider sends. Offered only when the runtime names its
                        model with a launch-line label (`check.renameTo`), which
                        makes the fix a rename of the loaded weights rather than
                        a multi-gigabyte download. */}
                    {check.renameTo && onServeWantedModel && (
                      <button
                        type="button"
                        onClick={() => onServeWantedModel(check.renameTo)}
                        disabled={serving}
                        className={`${ACTION_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
                        title={`Restart ${label} serving the model it already has loaded under the id ${check.renameTo}. No weights are downloaded.`}
                      >
                        <RefreshCw size={12} className={serving ? 'animate-spin' : ''} />
                        {serving ? 'Restarting…' : `Serve as ${check.renameTo}`}
                      </button>
                    )}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3 pt-1.5">
        {setup?.action && onAutoSetup && (
          <button
            type="button"
            onClick={() => onAutoSetup(setup)}
            className={ACTION_CLASS}
            // Provisioning is the one thing here that spends gigabytes, so the
            // button says so before it is clicked rather than after. The label
            // already names the payload; this says where it lands.
            title={setup.provisions
              ? `${setup.actionLabel} — a multi-gigabyte download onto this host, then ${label} starts on ${endpoint}.`
              : `PortOS runs this on ${endpoint} for you — no terminal needed.`}
          >
            {setup.provisions ? <Download size={12} /> : <Wand2 size={12} />}
            {setup.actionLabel}
          </button>
        )}
        {manageUrl && (
          <Link to={manageUrl} className={ACTION_CLASS}>Open the LLMs page</Link>
        )}
      </div>
    </Banner>
  );
}
