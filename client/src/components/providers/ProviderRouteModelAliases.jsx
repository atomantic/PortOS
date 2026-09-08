import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { routeModelAliasRows } from '../../lib/providerManagement';

/**
 * Hand-authored model aliases for one route (#6369).
 *
 * A route's alias map answers "what does THIS harness have to be sent for a
 * given canonical backend model". A refresh fills it only with the pairs it can
 * verify — an OpenCode route needs `<namespace>/<model>`, so a bare string
 * stored on it round-trips to nothing and never reaches the shared catalog,
 * which means no harness model menu can offer it. This is where a human
 * supplies the pair by hand.
 *
 * The merge rule the copy below states, and the server enforces:
 *
 *   - A manual alias WINS over the one a refresh observed for the same model,
 *     and survives every later refresh, because the two are stored apart.
 *   - Removing one is an explicit act. Nothing else deletes it — an alias
 *     naming a spelling the route no longer lists is marked stale and kept,
 *     the same way a model pin outside the catalog stays visible.
 *
 * Presentation only: the list is whatever the server published, so a build that
 * has never seen a given alias still renders it.
 */
export default function ProviderRouteModelAliases({ route, busy, blocked, onSaveAliases }) {
  const [canonical, setCanonical] = useState('');
  const [executable, setExecutable] = useState('');

  const rows = routeModelAliasRows(route);
  const id = (suffix) => `route-${route.providerId}-alias-${suffix}`;
  const ready = canonical.trim() !== '' && executable.trim() !== '';

  const add = async () => {
    const saved = await onSaveAliases(route, { [canonical.trim()]: executable.trim() });
    // Clear only on a save that landed, so a 409 leaves the typed pair in place
    // to re-submit rather than making the human retype it.
    if (saved) {
      setCanonical('');
      setExecutable('');
    }
  };

  return (
    <div className="space-y-2 border-t border-port-border pt-2">
      <p className="text-xs text-port-muted">
        Model aliases — what this harness is sent for each backend model. A manual alias wins over
        the one a refresh found and survives the next refresh; only you remove it.
      </p>

      {rows.length > 0 && (
        <ul className="space-y-1 text-xs">
          {rows.map((row) => (
            <li key={row.canonical} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{row.canonical}</span>
              <span aria-hidden="true">→</span>
              <span className="font-mono">{row.executable}</span>
              {row.manual && <span className="rounded bg-port-bg px-1.5 py-0.5 text-port-muted">manual</span>}
              {row.stale && (
                <span className="text-port-warning">
                  this route no longer lists that spelling — kept as-is
                </span>
              )}
              {row.manual && (
                <button
                  type="button"
                  disabled={busy || blocked}
                  onClick={() => onSaveAliases(route, { [row.canonical]: null })}
                  aria-label={`Remove the manual alias for ${row.canonical}`}
                  className="flex items-center gap-1 text-port-muted hover:text-port-error disabled:opacity-50"
                >
                  <Trash2 size={12} aria-hidden="true" /> Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-sm" htmlFor={id('canonical')}>
          <span className="mb-1 block text-xs text-port-muted">Backend model name</span>
          <input
            id={id('canonical')}
            className="w-full rounded border border-port-border bg-port-bg px-2 py-1 font-mono text-xs"
            placeholder="example-model"
            value={canonical}
            onChange={(e) => setCanonical(e.target.value)}
          />
        </label>
        <label className="block text-sm" htmlFor={id('executable')}>
          <span className="mb-1 block text-xs text-port-muted">What this harness is sent</span>
          <input
            id={id('executable')}
            className="w-full rounded border border-port-border bg-port-bg px-2 py-1 font-mono text-xs"
            placeholder="namespace/example-model"
            value={executable}
            onChange={(e) => setExecutable(e.target.value)}
          />
        </label>
      </div>

      <button
        type="button"
        disabled={busy || blocked || !ready}
        onClick={add}
        className="rounded border border-port-border px-3 py-1 text-sm disabled:opacity-50"
      >
        Add alias
      </button>
    </div>
  );
}
