import { Plus } from 'lucide-react';
import { transportProtocolOptions } from '../../lib/providerManagement';

/**
 * Add a backend (#6369) — mock flow 3 in the design record: a new endpoint with
 * its own credentials, created as its own identity even when its models match a
 * backend already configured. Nothing is contacted when it saves.
 *
 * ONE transport, which is the server's rule too: a provider record names one
 * endpoint, so a backend declaring two could never be the backend its own
 * routes describe.
 *
 * The kind and protocol options come from the graph response
 * (`creatableConnectionKinds`, `creatableHarnesses`) rather than a table
 * mirrored into the browser — which backends a minted route can honestly
 * describe is a server decision.
 */
export default function ProviderConnectionForm({ graph, draft, onChange, onSubmit, open, onToggle, busy }) {
  const field = (key) => (event) => onChange({ ...draft, [key]: event.target.value });

  return (
    <div className="rounded-lg border border-dashed border-port-border p-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1 text-sm font-medium"
      >
        <Plus size={14} aria-hidden="true" /> Add a backend
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm" htmlFor="new-backend-label">
              <span className="mb-1 block text-port-muted">Backend name</span>
              <input
                id="new-backend-label"
                className="w-full rounded border border-port-border bg-port-bg px-2 py-1"
                value={draft.label}
                onChange={field('label')}
              />
            </label>
            <label className="block text-sm" htmlFor="new-backend-kind">
              <span className="mb-1 block text-port-muted">Backend</span>
              <select
                id="new-backend-kind"
                className="w-full rounded border border-port-border bg-port-bg px-2 py-1"
                value={draft.kind}
                onChange={field('kind')}
              >
                {(graph?.creatableConnectionKinds || []).map((kind) => (
                  <option key={kind.id} value={kind.id}>{kind.label}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm" htmlFor="new-backend-protocol">
              <span className="mb-1 block text-port-muted">Wire protocol</span>
              <select
                id="new-backend-protocol"
                className="w-full rounded border border-port-border bg-port-bg px-2 py-1"
                value={draft.protocol}
                onChange={field('protocol')}
              >
                {transportProtocolOptions(graph).map((option) => (
                  <option key={option.protocol} value={option.protocol}>
                    {option.protocol} — {option.drivers.join(', ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm" htmlFor="new-backend-url">
              <span className="mb-1 block text-port-muted">Base URL</span>
              <input
                id="new-backend-url"
                className="w-full rounded border border-port-border bg-port-bg px-2 py-1"
                value={draft.baseUrl}
                onChange={field('baseUrl')}
                placeholder="http://127.0.0.1:11434"
              />
            </label>
            <label className="block text-sm" htmlFor="new-backend-credential-key">
              <span className="mb-1 block text-port-muted">Credential name (optional)</span>
              <input
                id="new-backend-credential-key"
                className="w-full rounded border border-port-border bg-port-bg px-2 py-1"
                value={draft.credentialKey}
                onChange={field('credentialKey')}
                placeholder="apiKey"
              />
            </label>
            <label className="block text-sm" htmlFor="new-backend-credential">
              <span className="mb-1 block text-port-muted">Credential value (optional)</span>
              <input
                id="new-backend-credential"
                type="password"
                autoComplete="off"
                className="w-full rounded border border-port-border bg-port-bg px-2 py-1"
                value={draft.credential}
                onChange={field('credential')}
              />
            </label>
          </div>
          <p className="text-xs text-port-muted">
            Claude Code speaks <code>anthropic</code> and needs an <code>ANTHROPIC_AUTH_TOKEN</code> credential —
            any non-empty value works for a local daemon that ignores it. Nothing is contacted when you save this.
          </p>
          <button
            type="button"
            disabled={busy || !draft.label.trim() || !draft.baseUrl.trim()}
            onClick={onSubmit}
            className="rounded bg-port-accent px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            Add backend
          </button>
        </div>
      )}
    </div>
  );
}
