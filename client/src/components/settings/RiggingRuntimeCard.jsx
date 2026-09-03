import { useCallback, useEffect, useState } from 'react';
import BrailleSpinner from '../BrailleSpinner';
import { copyToClipboard } from '../../lib/clipboard.js';
import { riggingReasonLabel } from '../../lib/riggingReasons.js';
import { getRiggingReadiness } from '../../services/api';

// The rigging runtime's honest status, rendered inside the rigging row of
// Settings > Features. It fetches `GET /api/rigging/readiness` from HERE rather than
// riding the shared feature list, because the probe imports Blender's Python module —
// the feature list is read on every page load by the sidebar and the ⌘K palette, and
// this answer is only worth collecting on the tab that shows it.
//
// There is deliberately NO install button in this phase: the runtime is provisioned by
// one command the user runs themselves, so the card prints that command (copyable)
// instead of inventing a second install/progress affordance beside the 3D targets
// page's.
export function RiggingRuntimeCard() {
  const [readiness, setReadiness] = useState(null);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async ({ refresh = false } = {}) => {
    setChecking(true);
    // Silent: an unreadable probe is reported inline on the card, not as a toast —
    // this tab renders on every Settings visit and a toast would fire unprompted.
    const result = await getRiggingReadiness({ refresh, silent: true }).catch((err) => err);
    if (result instanceof Error) setError(result);
    else {
      setError(null);
      setReadiness(result);
    }
    setChecking(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCopy = () => copyToClipboard(readiness?.installCommand, 'Install command copied');

  if (error) {
    return (
      <div className="mt-3 text-xs text-port-error">
        <p>{error.message || 'Could not read the rigging runtime status'}</p>
        <button
          type="button"
          onClick={() => load({ refresh: true })}
          className="inline-flex items-center justify-center min-h-[44px] px-3 mt-2 text-sm bg-port-border hover:bg-port-border/70 text-white rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!readiness) return <div className="mt-3"><BrailleSpinner text="Checking the rigging runtime" /></div>;

  return (
    <div className="mt-3 space-y-2 text-xs text-gray-400">
      <p className={readiness.ready ? 'text-port-success' : 'text-port-warning'}>
        {readiness.ready ? 'Runtime installed' : riggingReasonLabel(readiness.reason)}
      </p>
      <p>{readiness.detail}</p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        <div className="min-w-0">
          <dt className="text-gray-500">Interpreter</dt>
          <dd className="break-all text-gray-300">{readiness.interpreter || 'Not resolved'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-gray-500">{readiness.module} version</dt>
          <dd className="break-all text-gray-300">
            {readiness.moduleVersion || `Not reported (pinned to ${readiness.modulePin})`}
          </dd>
        </div>
      </dl>
      {readiness.installCommand && (
        <div>
          <p className="text-gray-500 mb-1" id="rigging-install-command-label">Install command</p>
          <code
            aria-labelledby="rigging-install-command-label"
            className="block w-full overflow-x-auto whitespace-pre bg-port-bg border border-port-border rounded-lg px-3 py-2 text-gray-300"
          >
            {readiness.installCommand}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center justify-center min-h-[44px] px-3 mt-2 text-sm bg-port-border hover:bg-port-border/70 text-white rounded transition-colors"
          >
            Copy command
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => load({ refresh: true })}
        disabled={checking}
        className="inline-flex items-center justify-center min-h-[44px] px-3 text-sm bg-port-border hover:bg-port-border/70 disabled:opacity-50 text-white rounded transition-colors"
      >
        {checking ? 'Rechecking…' : 'Recheck runtime'}
      </button>
    </div>
  );
}

export default RiggingRuntimeCard;
