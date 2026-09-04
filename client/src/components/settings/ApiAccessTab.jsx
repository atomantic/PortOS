import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
import { Bot, Globe, Lock, Unlock, Copy, RefreshCw, ExternalLink } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { getApiCatalog, getSettings, updateSettings, getOpenApiSpec } from '../../services/apiSystem';
import { copyToClipboard } from '../../lib/clipboard';

const DEFAULT_ACCESS = { exposed: false, requireAuth: false };
const DEFAULT_AGENT_CONTEXT = {
  enabled: false,
  profile: 'metadata',
  scopes: ['navigation', 'workspaces'],
  actions: { readPortos: false, writePortos: false, manageEidoverse: false },
};
const AGENT_CONTEXT_SCOPES = [
  { id: 'navigation', label: 'Navigation', hint: 'PortOS page labels, aliases, and paths.' },
  { id: 'workspaces', label: 'Workspaces', hint: 'App presence and task counts; never repository paths or branches.' },
  { id: 'brain', label: 'Brain', hint: 'Searchable Brain records; metadata-only unless summary mode is selected.' },
  { id: 'identity', label: 'Identity export', hint: 'Section presence only; never raw identity records or Privacy Vault data.' },
];

const exampleCurl = (card, baseUrl) => {
  const example = card.example || {};
  const lines = [`curl -X ${example.method || 'GET'} ${baseUrl}${example.path || card.publicBase}`];
  if (example.body) {
    lines.push("  -H 'content-type: application/json'");
    lines.push(`  -d '${JSON.stringify(example.body)}'`);
  }
  if (example.output) lines.push(`  --output ${example.output}`);
  return lines.join(' \\\n');
};

const Toggle = ({ id, checked, onChange, label, hint, disabled }) => (
  <div className={`flex items-start gap-3 ${disabled ? 'opacity-50' : ''}`}>
    <input
      id={id}
      aria-label={label}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="w-4 h-4 mt-0.5 shrink-0"
    />
    <label htmlFor={id} className={`flex flex-col min-w-0 flex-1 ${disabled ? '' : 'cursor-pointer'}`}>
      <span className="text-sm text-white">{label}</span>
      {hint && <span className="text-xs text-gray-500">{hint}</span>}
    </label>
  </div>
);

export function ApiAccessTab() {
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [access, setAccess] = useState({});
  const [agentContext, setAgentContext] = useState(DEFAULT_AGENT_CONTEXT);
  const [spec, setSpec] = useState(null);
  const [apiCards, setApiCards] = useState(null);
  const [apiCatalogError, setApiCatalogError] = useState('');

  // window.location.origin is the tailnet host the user is browsing from, so
  // the example curls are copy-pasteable from this machine.
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const loadSpec = useCallback(() => {
    getOpenApiSpec({ silent: true })
      .then(setSpec)
      .catch(() => setSpec(null));
  }, []);

  const loadApiCards = useCallback(() => {
    setApiCatalogError('');
    getApiCatalog({ silent: true })
      .then((catalog) => setApiCards(catalog.externallyExposableApis || []))
      .catch((error) => setApiCatalogError(error?.message || 'API catalog unavailable'));
  }, []);

  useEffect(() => {
    getSettings({ silent: true })
      .then((s) => {
        setAccess(s?.apiAccess || {});
        setAgentContext({
          ...DEFAULT_AGENT_CONTEXT,
          ...(s?.agentContext || {}),
          scopes: s?.agentContext?.scopes?.length ? s.agentContext.scopes : DEFAULT_AGENT_CONTEXT.scopes,
          actions: { ...DEFAULT_AGENT_CONTEXT.actions, ...(s?.agentContext?.actions || {}) },
        });
      })
      .catch(() => toast.error('Failed to load API access settings'))
      .finally(() => setLoading(false));
    loadApiCards();
    loadSpec();
  }, [loadApiCards, loadSpec]);

  const entryFor = (id) => ({ ...DEFAULT_ACCESS, ...(access[id] || {}) });

  // Persist a single API's flags. Optimistic local update; revert on failure.
  const patchAccess = async (id, partial) => {
    const prev = entryFor(id);
    const next = { ...prev, ...partial };
    setAccess((a) => ({ ...a, [id]: next }));
    setSavingId(id);
    try {
      // PUT /api/settings shallow-merges only TOP-LEVEL keys, so sending just
      // `{ apiAccess: { [id]: next } }` would REPLACE the whole apiAccess object
      // and wipe the other API's persisted flags. Send the full merged map so
      // every API's entry survives.
      await updateSettings({ apiAccess: { ...access, [id]: next } }, { silent: true });
      loadSpec(); // exposed-set changed → refresh the documented paths
    } catch (err) {
      setAccess((a) => ({ ...a, [id]: prev })); // revert
      toast.error(`Failed to save: ${err.message}`);
    } finally {
      setSavingId(null);
    }
  };

  const patchAgentContext = async (partial) => {
    const prev = agentContext;
    const next = { ...prev, ...partial };
    setAgentContext(next);
    setSavingId('agent-context');
    try {
      await updateSettings({ agentContext: next }, { silent: true });
    } catch (err) {
      setAgentContext(prev);
      toast.error(`Failed to save: ${err.message}`);
    } finally {
      setSavingId(null);
    }
  };

  const patchAgentContextScope = (scope, checked) => {
    const scopes = checked
      ? [...new Set([...agentContext.scopes, scope])]
      : agentContext.scopes.filter((candidate) => candidate !== scope);
    if (scopes.length > 0) patchAgentContext({ scopes });
  };

  const patchAgentContextAction = (action, checked) => patchAgentContext({
    actions: { ...agentContext.actions, [action]: checked },
  });

  if (loading) return <BrailleSpinner text="Loading API access settings" />;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-2">
        <div className="flex items-center gap-2 text-white">
          <Globe size={18} />
          <h2 className="text-lg font-semibold">API Access</h2>
        </div>
        <p className="text-xs text-gray-500">
          Expose individual PortOS services as HTTP APIs on your network. When you enable a
          PortOS password (Settings → Security), the whole app is gated by default — but an
          exposed API here can stay <strong>passwordless</strong> so other machines on your
          tailnet can call it. Toggle <em>Require auth</em> to gate a specific API behind the
          password while leaving the rest open. Only read/synthesis endpoints are public;
          config and control endpoints always require the password.
        </p>
        <Link to="/api-reference/catalog" className="inline-flex items-center gap-1 text-xs font-medium text-port-accent hover:underline">
          Browse all APIs <ExternalLink size={11} />
        </Link>
      </div>

      {apiCatalogError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-port-error/40 bg-port-error/5 p-4 text-sm text-port-error">
          <span>API exposure controls are unavailable: {apiCatalogError}</span>
          <button type="button" onClick={loadApiCards} className="rounded border border-port-error/40 px-3 py-1.5 text-xs hover:bg-port-error/10">Retry</button>
        </div>
      )}
      {apiCards === null && !apiCatalogError && <BrailleSpinner text="Loading API catalog" />}

      {(apiCards || []).map((card) => {
        const settingsKey = card.settingsKey || card.id;
        const entry = entryFor(settingsKey);
        // Disable EVERY card's toggles while ANY save is in flight, not just
        // this card's. Each PUT sends a full apiAccess snapshot and the server
        // replaces the whole key, so two overlapping saves could let the older
        // one land last and clobber the newer toggle. Serializing to one save
        // at a time removes the race. `cardBusy` still drives this card's spinner.
        const cardBusy = savingId === settingsKey;
        const busy = savingId !== null;
        return (
          <div key={card.id} className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-white">
                  <h3 className="text-base font-semibold">{card.label}</h3>
                  {entry.exposed ? (
                    entry.requireAuth
                      ? <span className="inline-flex items-center gap-1 text-xs text-port-warning"><Lock size={12} /> auth required</span>
                      : <span className="inline-flex items-center gap-1 text-xs text-port-success"><Unlock size={12} /> passwordless</span>
                  ) : (
                    <span className="text-xs text-gray-500">not exposed</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1">{card.description}</p>
              </div>
              {cardBusy && <BrailleSpinner />}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Toggle
                id={`api-${card.id}-exposed`}
                checked={entry.exposed}
                disabled={busy}
                onChange={(v) => patchAccess(settingsKey, { exposed: v })}
                label="Expose on the network"
                hint="Off by default. Nothing is reachable until you turn this on."
              />
              <Toggle
                id={`api-${card.id}-auth`}
                checked={entry.requireAuth}
                disabled={busy || !entry.exposed}
                onChange={(v) => patchAccess(settingsKey, { requireAuth: v })}
                label="Require auth (password)"
                hint="When off, this API is callable without the PortOS password."
              />
            </div>

            <div className="space-y-2">
              <div className="text-xs text-gray-400">Public base URL</div>
              <code className="block bg-port-bg border border-port-border rounded-lg px-3 py-2 text-xs text-port-accent break-all">
                {baseUrl}{card.publicBase}
              </code>
            </div>

            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer select-none">Example request</summary>
              <div className="mt-2 relative">
                <pre className="bg-port-bg border border-port-border rounded-lg p-3 overflow-x-auto text-[11px] text-gray-300 whitespace-pre">
{exampleCurl(card, baseUrl)}
                </pre>
                <button
                  type="button"
                  onClick={() => copyToClipboard(exampleCurl(card, baseUrl), 'Example copied')}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center absolute top-2 right-2 p-1.5 rounded bg-port-border hover:bg-port-border/70 text-white"
                  aria-label="Copy example request"
                  title="Copy example request"
                >
                  <Copy size={12} />
                </button>
              </div>
            </details>
          </div>
        );
      })}

      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-white">
              <Bot size={18} />
              <h3 className="text-base font-semibold">Agent Tools (MCP)</h3>
              <span className={`text-xs ${agentContext.enabled ? 'text-port-success' : 'text-gray-500'}`}>
                {agentContext.enabled ? 'local access enabled' : 'disabled'}
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              A governed context and semantic-action surface for CoS agents running on this machine.
              It accepts loopback connections only, never tailnet or public traffic, and makes no LLM
              calls by itself. Context and action grants are independently opt-in.
            </p>
          </div>
          {savingId === 'agent-context' && <BrailleSpinner />}
        </div>

        <Toggle
          id="agent-context-enabled"
          checked={agentContext.enabled}
          disabled={savingId !== null}
          onChange={(enabled) => patchAgentContext({ enabled })}
          label="Enable local MCP context"
          hint="Off by default. Enabling does not expose the endpoint beyond this machine."
        />

        <fieldset className="space-y-2" disabled={savingId !== null}>
          <legend className="text-xs font-medium text-gray-300 mb-2">Allowed context scopes</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {AGENT_CONTEXT_SCOPES.map((scope) => {
              const checked = agentContext.scopes.includes(scope.id);
              return (
                <Toggle
                  key={scope.id}
                  id={`agent-context-scope-${scope.id}`}
                  checked={checked}
                  disabled={savingId !== null || (checked && agentContext.scopes.length === 1)}
                  onChange={(value) => patchAgentContextScope(scope.id, value)}
                  label={scope.label}
                  hint={scope.hint}
                />
              );
            })}
          </div>
        </fieldset>

        <fieldset className="space-y-2" disabled={savingId !== null}>
          <legend className="text-xs font-medium text-gray-300 mb-2">Semantic action grants</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Toggle
              id="agent-context-action-read"
              checked={agentContext.actions.readPortos}
              disabled={savingId !== null}
              onChange={(value) => patchAgentContextAction('readPortos', value)}
              label="Allow semantic PortOS reads"
              hint="Brain, goals, journal, calendar, health, feed, catalog, and runtime adapters."
            />
            <Toggle
              id="agent-context-action-write"
              checked={agentContext.actions.writePortos}
              disabled={savingId !== null}
              onChange={(value) => patchAgentContextAction('writePortos', value)}
              label="Allow semantic PortOS updates"
              hint="Typed Brain, journal, goals, health-log, and feed-state actions; no raw routes or shell."
            />
            <Toggle
              id="agent-context-action-eidoverse"
              checked={agentContext.actions.manageEidoverse}
              disabled={savingId !== null}
              onChange={(value) => patchAgentContextAction('manageEidoverse', value)}
              label="Allow private Eidoverse world management"
              hint="Project resources, build bounded content, manage world roles, and speak as the persistent CoS identity."
            />
          </div>
          <p className="text-xs text-gray-500">
            All grants default off. MCP advertises only granted actions, with schemas generated from the same contracts used at runtime.
          </p>
        </fieldset>

        <div className="space-y-1">
          <label htmlFor="agent-context-profile" className="text-xs font-medium text-gray-300">Disclosure profile</label>
          <select
            id="agent-context-profile"
            value={agentContext.profile}
            disabled={savingId !== null}
            onChange={(event) => patchAgentContext({ profile: event.target.value })}
            className="block w-full sm:max-w-md bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            <option value="metadata">Metadata only (recommended)</option>
            <option value="summary">Redacted summaries</option>
          </select>
          <p className="text-xs text-gray-500">
            Metadata mode can match private text but returns only generic record labels and stable opaque references.
          </p>
        </div>

        <div className="space-y-1">
          <div className="text-xs text-gray-400">Local Streamable HTTP endpoint</div>
          <code className="block bg-port-bg border border-port-border rounded-lg px-3 py-2 text-xs text-port-accent break-all">
            /api/agent-context/mcp
          </code>
          <p className="text-xs text-gray-500">
            Runtime manifest: <code className="text-port-accent">/api/agent-context/manifest</code>
          </p>
        </div>
      </div>

      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-white">OpenAPI spec</h3>
          <button
            type="button"
            onClick={loadSpec}
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-port-border hover:bg-port-border/70 text-white text-xs rounded-lg"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Machine-readable description of every exposed API. Served at{' '}
          <code className="text-port-accent">/api/api-docs/openapi.json</code>.
        </p>
        <Link to="/api-reference/rest" className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline">
          Open rendered reference <ExternalLink size={11} />
        </Link>
        {spec ? (
          <div className="text-xs text-gray-400">
            <span className="text-port-success">{Object.keys(spec.paths || {}).length}</span> path(s) documented
            {Object.keys(spec.paths || {}).length === 0 && ' — expose an API above to populate the spec.'}
          </div>
        ) : (
          <div className="text-xs text-gray-500">Spec unavailable.</div>
        )}
      </div>
    </div>
  );
}

export default ApiAccessTab;
