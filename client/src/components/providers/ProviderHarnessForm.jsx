import { Plus } from 'lucide-react';
import { connectionProtocol, harnessOptionsFor } from '../../lib/providerManagement';

/**
 * Add a harness to a backend (#6369) — mock flow 2: the same daemon, driven by
 * a second program, as an independent binding with its own executable routes.
 *
 * Two rules the control is built around:
 *
 *   - **Only harnesses that speak this backend are offered.** The server
 *     refuses one that does not, and an option whose only outcome is a 409 is
 *     not an option. A program that needs a credential the backend has not got
 *     is shown and disabled WITH the reason, rather than hidden.
 *   - **Nothing created here is enabled.** New routes arrive disabled with no
 *     model pins; granting execution stays an explicit edit on the route
 *     editor. The copy says so, because the button does not.
 */
export default function ProviderHarnessForm({ graph, connection, draft, onChange, onSubmit, busy }) {
  const options = harnessOptionsFor(graph, connection);
  if (options.length === 0) {
    return (
      <p className="text-xs text-port-muted">
        No harness PortOS can point at a {connectionProtocol(connection) || 'transport-less'} backend.
      </p>
    );
  }

  const current = draft || { harnessId: options[0].harnessId, modes: options[0].modes };
  const chosen = options.find((option) => option.harnessId === current.harnessId) || options[0];

  return (
    <div className="rounded border border-dashed border-port-border p-3">
      <h4 className="mb-2 text-sm font-medium">Add a harness</h4>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm" htmlFor={`add-harness-${connection.id}`}>
          <span className="mb-1 block text-port-muted">Program</span>
          <select
            id={`add-harness-${connection.id}`}
            className="rounded border border-port-border bg-port-bg px-2 py-1"
            value={chosen.harnessId ?? ''}
            disabled={busy}
            onChange={(event) => {
              const next = options.find((option) => (option.harnessId ?? '') === event.target.value);
              onChange({ harnessId: next?.harnessId ?? null, modes: next?.modes ?? [] });
            }}
          >
            {options.map((option) => (
              <option key={option.harnessId ?? 'api'} value={option.harnessId ?? ''}>{option.label}</option>
            ))}
          </select>
        </label>

        <fieldset>
          <legend className="mb-1 text-xs text-port-muted">Modes</legend>
          <div className="flex flex-wrap gap-2">
            {chosen.modes.map((mode) => (
              <label key={mode} className="flex items-center gap-1 text-sm" htmlFor={`add-mode-${connection.id}-${mode}`}>
                <input
                  id={`add-mode-${connection.id}-${mode}`}
                  type="checkbox"
                  checked={current.modes.includes(mode)}
                  disabled={busy}
                  onChange={(event) => onChange({
                    harnessId: chosen.harnessId,
                    // Kept in the harness's own mode order, so a route set always
                    // reads cli-then-tui however it was clicked.
                    modes: chosen.modes.filter((entry) => (entry === mode
                      ? event.target.checked
                      : current.modes.includes(entry))),
                  })}
                />
                {mode}
              </label>
            ))}
          </div>
        </fieldset>

        <button
          type="button"
          disabled={busy || current.modes.length === 0 || Boolean(chosen.needsCredential)}
          onClick={() => onSubmit({ harnessId: chosen.harnessId, modes: current.modes })}
          className="flex items-center gap-1 rounded bg-port-accent px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          <Plus size={14} aria-hidden="true" /> Add
        </button>
      </div>

      {chosen.needsCredential && (
        <p className="mt-2 text-xs text-port-warning">
          {chosen.label} will not start without a <code>{chosen.needsCredential}</code>.
          Set one on this backend above first.
        </p>
      )}
      <p className="mt-2 text-xs text-port-muted">
        New routes arrive disabled with no model pins. Enable one on its route editor when you want it to run.
      </p>
    </div>
  );
}
