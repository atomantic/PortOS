import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import toast from '../ui/Toast';
import Drawer from '../Drawer';
import Banner from '../ui/Banner';
import { FormField } from '../ui/FormField';
import { INPUT_CLASS } from '../apps/constants';
import * as api from '../../services/api';
import { SERVICE_SLUG_RE } from '../../../../server/lib/serviceDefinitions.js';
import { transportsFromDraft } from '../../lib/providerManagement';

/**
 * "Add service" (#7567): definition → plan → credential / endpoint, in that
 * order, each step narrowing the next. A service INSTANCE is a definition the
 * user declared a plan for and gave a credential or an endpoint; nothing is
 * probed on create, and the catalog starts `unknown` until the card's explicit
 * Refresh — the same contract as `POST /api/providers/services`.
 *
 * Family decides which step applies:
 *   - `subscription` — auth lives in the harness; neither a key nor an endpoint.
 *   - `api-key` — an optional key for a bare OpenAI-compatible endpoint, or a
 *     required vendor key (stored here, read from the environment, or minted
 *     by a bootstrap wrapper at spawn) plus the transport's default endpoint.
 *   - `local` / `fleet` — an endpoint, required, because a daemon's port is
 *     decided per install and the definition declares none.
 */

const FAMILY_ORDER = ['api-key', 'local', 'subscription', 'fleet'];
const FAMILY_LABEL = {
  'api-key': 'Hosted APIs (key)',
  local: 'Local runtimes',
  subscription: 'Subscriptions (sign in through the harness)',
  fleet: 'Fleet hosts',
};
const PLAN_LABEL = { free: 'Free tier', paid: 'Paid / metered', subscription: 'Subscription', local: 'Local (no billing)' };
// The static `/ai/services/new` route would shadow a card addressed by this slug.
const RESERVED_SLUGS = new Set(['new']);

const EMPTY_DRAFT = Object.freeze({ definitionId: '', plan: '', label: '', slug: '', transports: {}, apiKey: '', credentialVia: 'stored' });

/** The transports a definition declares, as text the form edits, pre-filled from its defaults. */
const transportsDraftFor = (definition) => Object.fromEntries(
  Object.entries(definition?.transports || {}).map(([protocol, transport]) => [protocol, transport.defaultBaseUrl || '']),
);

export default function ProviderServiceForm({ onClose, onCreated }) {
  const [definitions, setDefinitions] = useState(null); // null = not fetched yet
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }));

  useEffect(() => {
    let active = true;
    api.getProviderServiceDefinitions({ silent: true })
      .then((data) => { if (active) setDefinitions(Array.isArray(data?.definitions) ? data.definitions : []); })
      .catch(() => { if (active) setDefinitions([]); });
    return () => { active = false; };
  }, []);

  const grouped = useMemo(() => FAMILY_ORDER
    .map((family) => ({ family, rows: (definitions || []).filter((row) => row.family === family) }))
    .filter((group) => group.rows.length > 0), [definitions]);
  const definition = (definitions || []).find((row) => row.id === draft.definitionId) || null;

  const pickDefinition = (definitionId) => {
    const next = (definitions || []).find((row) => row.id === definitionId) || null;
    setDraft({
      ...EMPTY_DRAFT,
      definitionId,
      plan: next?.plans?.[0] || '',
      transports: transportsDraftFor(next),
    });
  };

  const supportsApiKey = definition?.family === 'api-key';
  const hasCredentialSources = supportsApiKey && definition.envVars.length > 0;
  const declaredTransports = Object.entries(draft.transports);
  const endpointRequired = definition && definition.family !== 'subscription'
    && declaredTransports.length > 0 && declaredTransports.every(([, baseUrl]) => !baseUrl.trim());

  const submit = async (e) => {
    e.preventDefault();
    if (!definition) return;
    if (endpointRequired) {
      toast.error('This service declares no default endpoint — enter the one this install reaches it at');
      return;
    }
    if (RESERVED_SLUGS.has(draft.slug.trim())) {
      toast.error(`"${draft.slug.trim()}" is reserved by the page's own routes — pick another slug`);
      return;
    }
    const transports = transportsFromDraft(draft.transports);
    const body = {
      definitionId: definition.id,
      plan: draft.plan || undefined,
      ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
      ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
      ...(Object.keys(transports).length > 0 ? { transports } : {}),
      ...(supportsApiKey ? { credentialVia: draft.credentialVia } : {}),
      ...(supportsApiKey && draft.credentialVia === 'stored' && draft.apiKey.trim() ? { credentials: { apiKey: draft.apiKey.trim() } } : {}),
    };
    setBusy(true);
    const result = await api.createProviderService(body, { silent: true }).catch((err) => ({ error: err?.message || 'Could not add the service' }));
    setBusy(false);
    if (!result?.service) {
      toast.error(result?.error || 'Could not add the service');
      return;
    }
    toast.success(`${result.service.label} added — nothing was contacted; refresh its catalog when ready`);
    onCreated(result.service);
  };

  return (
    <Drawer open onClose={onClose} title="Add service" size="md" closeLabel="Close add service" closeOnBackdrop={false}>
      <form onSubmit={submit} className="space-y-4">
        {definitions !== null && definitions.length === 0 && (
          <Banner tone="error" size="sm">Could not load the service definitions from this server.</Banner>
        )}
        <FormField label="Service *" hint="The backend a harness can be pointed at">
          <select
            id="service-definition"
            value={draft.definitionId}
            onChange={(e) => pickDefinition(e.target.value)}
            required
            className={INPUT_CLASS}
          >
            <option value="">{definitions === null ? 'Loading…' : 'Choose a service'}</option>
            {grouped.map((group) => (
              <optgroup key={group.family} label={FAMILY_LABEL[group.family]}>
                {group.rows.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
              </optgroup>
            ))}
          </select>
        </FormField>

        {definition && (
          <>
            <FormField label="Plan *" hint="What you are entitled to on it — decides which models the catalog keeps and how cost is attributed">
              <select id="service-plan" value={draft.plan} onChange={set('plan')} className={INPUT_CLASS}>
                {definition.plans.map((plan) => <option key={plan} value={plan}>{PLAN_LABEL[plan] || plan}</option>)}
              </select>
            </FormField>

            {definition.family === 'subscription' && (
              <Banner tone="info" size="sm">
                Sign-in lives inside the {definition.harnessOnly || 'harness'} program. PortOS holds no key for it.
              </Banner>
            )}

            {supportsApiKey && (
              <fieldset className="space-y-2">
                <legend className="text-sm text-gray-400">Credential</legend>
                {hasCredentialSources && (
                  <div className="flex flex-wrap gap-3 text-sm text-gray-300">
                    {[['stored', 'Store a key here'], ['env', `Read ${definition.envVars[0]} from the environment`], ['bootstrap', 'A bootstrap wrapper supplies it at spawn']].map(([via, label]) => (
                      <label key={via} htmlFor={`service-via-${via}`} className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          id={`service-via-${via}`}
                          type="radio"
                          name="service-credential-via"
                          value={via}
                          checked={draft.credentialVia === via}
                          onChange={() => setDraft((prev) => ({ ...prev, credentialVia: via }))}
                          className="accent-port-accent"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                )}
                {draft.credentialVia === 'stored' && (
                  <FormField label={hasCredentialSources ? 'API key' : 'API key (optional)'} compact>
                    <input
                      id="service-api-key"
                      type="password"
                      autoComplete="off"
                      value={draft.apiKey}
                      onChange={set('apiKey')}
                      className={INPUT_CLASS}
                      placeholder="Paste the key, or leave blank to add it later"
                    />
                  </FormField>
                )}
                {!hasCredentialSources && (
                  <p className="text-xs text-gray-500">
                    This endpoint may require a key. It is stored on this service and used for requests to its endpoint.
                  </p>
                )}
                {definition.keyUrl && (
                  <a href={definition.keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline">
                    Get a key <ExternalLink className="w-3 h-3" aria-hidden="true" />
                  </a>
                )}
              </fieldset>
            )}

            {declaredTransports.map(([protocol, baseUrl]) => (
              <FormField
                key={protocol}
                label={`${protocol} endpoint${definition.family === 'api-key' ? '' : ' *'}`}
                hint={definition.family === 'api-key' ? 'The vendor default — change it only for a self-hosted gateway' : 'Where this install reaches the daemon'}
              >
                <input
                  id={`service-endpoint-${protocol}`}
                  type="url"
                  value={baseUrl}
                  required={definition.family !== 'api-key'}
                  onChange={(e) => setDraft((prev) => ({ ...prev, transports: { ...prev.transports, [protocol]: e.target.value } }))}
                  className={INPUT_CLASS}
                  placeholder="http://localhost:11434/v1"
                />
              </FormField>
            ))}

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Label" hint={`Defaults to "${definition.label}"`} compact>
                <input id="service-label" type="text" value={draft.label} onChange={set('label')} className={INPUT_CLASS} />
              </FormField>
              <FormField label="Slug" hint={`The address a composite id names; defaults to "${definition.id}"`} compact>
                <input id="service-slug" type="text" value={draft.slug} pattern={SERVICE_SLUG_RE.source.slice(1, -1)} onChange={set('slug')} className={INPUT_CLASS} placeholder={definition.id} />
              </FormField>
            </div>
          </>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          <button type="submit" disabled={busy || !definition} className="px-4 py-2 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50">
            {busy ? 'Adding…' : 'Add service'}
          </button>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white">
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
}
