import { ExternalLink, KeyRound, Copy } from 'lucide-react';
import Banner from '../ui/Banner';
import BrailleSpinner from '../BrailleSpinner';
import useForgeScopeRefresh from '../../hooks/useForgeScopeRefresh';
import { copyToClipboard } from '../../lib/clipboard';

export const FORGE_SCOPE_MISSING_CODE = 'FORGE_TOKEN_SCOPE_MISSING';

/** The `{ host, scopes, command, refreshable, message }` a scope-missing API error carries, or null for any other error. */
export const forgeScopeFailureFrom = err => (err?.code === FORGE_SCOPE_MISSING_CODE && err.context?.host
  ? { ...err.context, message: err.message }
  : null);

const buttonClass = 'px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 border border-port-border rounded-lg text-xs flex items-center gap-1 disabled:opacity-50';

/**
 * What to do when a forge call failed because the token lacks an OAuth scope.
 * Always shows the exact command to run by hand; when the server says it can
 * drive the refresh (`refreshable`), also offers to run it and shows the
 * one-time code to approve in a browser. `onRefreshed` is the caller's cue to
 * retry whatever failed.
 */
export default function ForgeScopeFix({ appId, failure, onRefreshed, onDismiss }) {
  const { active, pending, device, start, cancel } = useForgeScopeRefresh({ appId, onRefreshed });
  const scopeList = failure.scopes.join(', ');

  return (
    <Banner
      tone="warning"
      size="md"
      icon={KeyRound}
      title={`The ${failure.host} token is missing the ${scopeList} scope`}
      actions={!active && onDismiss ? (
        <button type="button" onClick={onDismiss} className="text-xs text-gray-400 hover:text-white">Dismiss</button>
      ) : null}
    >
      <p className="text-gray-300">{failure.message}</p>

      {device && (
        <div className="mt-3 space-y-2">
          <p className="text-gray-300">Enter this one-time code on {failure.host} to approve the new scope:</p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="px-3 py-1.5 bg-port-bg border border-port-border rounded-lg text-lg font-mono tracking-widest text-white select-all">{device.code}</code>
            <button type="button" onClick={() => copyToClipboard(device.code, 'Code copied')} className={buttonClass}>
              <Copy size={12} aria-hidden="true" /> Copy code
            </button>
            <a href={device.url} target="_blank" rel="noopener noreferrer" className={buttonClass}>
              <ExternalLink size={12} aria-hidden="true" /> Open {failure.host}
            </a>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {failure.refreshable && !active && (
          <button type="button" onClick={() => start(failure.scopes)} className={buttonClass}>
            <KeyRound size={12} aria-hidden="true" /> Authorize {scopeList}
          </button>
        )}
        {active && !device && <BrailleSpinner text={pending ? 'Starting gh auth refresh' : 'Waiting for gh to print a code'} />}
        {active && device && <BrailleSpinner text="Waiting for you to approve in the browser" />}
        {active && (
          <button type="button" onClick={cancel} className={buttonClass}>Cancel</button>
        )}
      </div>

      {failure.command ? (
        <div className="mt-3 text-xs text-gray-400">
          {failure.refreshable ? 'Or run' : 'Run'} this in a terminal on the PortOS host{failure.refreshable ? '' : ' (PortOS will not request this scope for you)'}:
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="px-2 py-1 bg-port-bg border border-port-border rounded text-gray-200 font-mono break-all">{failure.command}</code>
            <button type="button" onClick={() => copyToClipboard(failure.command, 'Command copied')} className={buttonClass}>
              <Copy size={12} aria-hidden="true" /> Copy
            </button>
          </div>
        </div>
      ) : (
        // A personal access token cannot be re-scoped by gh: it has to be reissued.
        <p className="mt-3 text-xs text-gray-400">
          This credential is a personal access token, which can&apos;t be updated in place. Reissue it with the {scopeList} scope and store the new one where PortOS reads it.
        </p>
      )}
    </Banner>
  );
}
