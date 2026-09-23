import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ExternalLink, Plug, RefreshCw, Trash2, Wand2 } from 'lucide-react';
import toast from '../ui/Toast';
import Banner from '../ui/Banner';
import Pill from '../ui/Pill';
import EmptyState from '../EmptyState';
import CollapsibleSection from '../ui/CollapsibleSection';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { FormField } from '../ui/FormField';
import ToggleSwitch from '../ToggleSwitch';
import { INPUT_CLASS } from '../apps/constants';
import * as api from '../../services/api';
import { invalidateProviderCatalog } from '../../hooks/useProviderCatalog';
import {
  SERVICE_CATEGORIES, catalogSummary, classifyServiceCategory, draftFromTransports, serviceCategoryById,
  serviceMatchesQuery, servicePresetAction, serviceReadinessCopy, sortServices, transportsFromDraft,
} from '../../lib/providerManagement';
import { pluralize } from '../../lib/textUtils';
import { formatCount } from '../../utils/formatters';
import ProviderReadiness from './ProviderReadiness';
import ProviderServiceForm from './ProviderServiceForm';
import { presetEditPath } from '../../utils/providerHarnesses';

/**
 * AI Providers → Services (#7567, epic #7561): one card per service INSTANCE —
 * a definition the user declared a plan for, holding a credential and the
 * catalog it last listed. This is the surface the Backend Connections drawer
 * (#6369) used to be: a connection IS a service instance, so its endpoint, key
 * and catalog are still edited once here and reach every preset derived from
 * it. What it no longer offers is binding link/unlink and per-route rows —
 * under the composed model a preset names its service outright
 * (`serviceId`), and a preset's own settings live on the preset editor.
 *
 * Nothing on this view contacts a provider on mount or on toggle. The one
 * outbound call is the explicit **Refresh** on a card, which lists the
 * instance's models through its definition's strategy.
 */

const PLAN_TONE = { free: 'success', paid: 'warning', subscription: 'accent', local: 'muted' };
const CREDENTIAL_SOURCE_COPY = {
  settings: 'Key stored on this service',
  env: 'Key read from the environment',
  'env-file': 'Key read from the install .env',
  cli: 'Signed in through the harness',
  config: 'Supplied by a bootstrap wrapper at spawn',
  none: 'No key',
};
const CATALOG_TONE_CLASS = { error: 'text-port-error', ok: 'text-port-success', warn: 'text-port-warning', muted: 'text-gray-500' };

const serviceName = (service) => service.label || service.slug || service.id;
const serviceRef = (service) => service.slug || service.id;

const draftFrom = (service) => ({ label: service.label || '', transports: draftFromTransports(service.transports), apiKey: '' });

function ServiceCard({
  service, open, busy, presets, subject, readiness, servingModel, onAutoSetup, onUseServedModel, onServeWantedModel,
  onSelect, onToggle, onRefresh, onSave, onClearKey, onDelete, onCreatePreset,
}) {
  const ref = useRef(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);
  // Re-seeded only when the row's revision moves, so a poll that changed
  // nothing cannot wipe a half-typed edit. The initial state already matches
  // the loaded service; skip the redundant mount reset so a fast first edit
  // cannot be overwritten by the passive effect.
  const [draft, setDraft] = useState(() => draftFrom(service));
  const draftVersionRef = useRef({ id: service.id, revision: service.revision });
  useEffect(() => {
    if (draftVersionRef.current.id === service.id && draftVersionRef.current.revision === service.revision) return;
    draftVersionRef.current = { id: service.id, revision: service.revision };
    setDraft(draftFrom(service));
  }, [service.id, service.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const set = (key) => (e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }));
  const setTransport = (protocol) => (e) => setDraft((prev) => ({ ...prev, transports: { ...prev.transports, [protocol]: e.target.value } }));

  const summary = catalogSummary(service.catalog);
  const readinessCopy = serviceReadinessCopy(service.readiness);
  const slug = serviceRef(service);
  const definition = service.definition;
  const category = serviceCategoryById(classifyServiceCategory(service));
  const presetAction = servicePresetAction(service);

  return (
    <article
      ref={ref}
      aria-labelledby={`service-${service.id}-title`}
      className={`min-w-0 bg-port-card border rounded-xl ${open ? 'border-port-accent ring-1 ring-port-accent/40' : 'border-port-border'}`}
    >
      <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
        <button
          type="button"
          onClick={() => onSelect(open ? null : slug)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <h3 id={`service-${service.id}-title`} className="text-base font-semibold text-white flex flex-wrap items-center gap-2">
            <Plug className="w-4 h-4 text-port-accent shrink-0" aria-hidden="true" />
            <span className="truncate">{serviceName(service)}</span>
            <code className="text-xs font-mono text-gray-500">{slug}</code>
          </h3>
          <p className="mt-1 text-xs text-gray-400 flex flex-wrap items-center gap-2">
            <span>{definition?.label || service.kind}</span>
            <Pill tone="accent" size="xs">{category.label}</Pill>
            <Pill tone={PLAN_TONE[service.plan] || 'muted'} size="xs">{service.plan}</Pill>
            <Pill tone={readinessCopy.tone} size="xs">{readinessCopy.label}</Pill>
            <span className={CATALOG_TONE_CLASS[summary.tone]}>{summary.text}</span>
          </p>
        </button>
        <div className="flex flex-col items-start gap-2 shrink-0 sm:items-end">
          <span className="flex items-center gap-2 text-sm text-gray-300">
            <ToggleSwitch
              size="sm"
              enabled={service.enabled}
              disabled={busy}
              ariaLabel={`${service.enabled ? 'Disable' : 'Enable'} ${serviceName(service)}`}
              onChange={() => onToggle(service, !service.enabled)}
            />
            {service.enabled ? 'Enabled' : 'Disabled'}
          </span>
          <button
            type="button"
            disabled={busy || !presetAction.enabled}
            aria-label={presetAction.label}
            onClick={() => {
              if (!presetAction.enabled) return;
              onCreatePreset?.(service);
            }}
            className="inline-flex min-h-[36px] items-center gap-1 px-2.5 py-1 text-xs rounded-lg border border-port-border text-gray-200 hover:text-white disabled:opacity-50"
          >
            <Wand2 className="w-3.5 h-3.5" aria-hidden="true" /> Create preset
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-4 border-t border-port-border p-4">
          {summary.detail && <Banner tone="error" size="sm">{summary.detail}</Banner>}

          <div className="text-xs text-gray-400 flex flex-wrap items-center gap-2">
            <span>{CREDENTIAL_SOURCE_COPY[service.credentialSource] || service.credentialSource}</span>
            {definition?.keyUrl && service.credentialSource === 'none' && (
              <a href={definition.keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-port-accent hover:underline">
                Get a key <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            )}
            {definition?.envVars?.length > 0 && service.credentialSource !== 'settings' && (
              <span className="text-gray-500">env: <code className="font-mono">{definition.envVars.join(', ')}</code></span>
            )}
          </div>

          <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))]">
            <FormField label="Name" compact>
              <input id={`service-label-${service.id}`} type="text" value={draft.label} onChange={set('label')} className={INPUT_CLASS} />
            </FormField>
            {Object.entries(draft.transports).map(([protocol, baseUrl]) => (
              <FormField key={protocol} label={`${protocol} endpoint`} compact>
                <input
                  id={`service-${service.id}-${protocol}`}
                  type="text"
                  value={baseUrl}
                  onChange={setTransport(protocol)}
                  className={INPUT_CLASS}
                />
              </FormField>
            ))}
            {service.credentialVia === 'stored' && (
              <FormField label={`API key ${service.hasCredentials ? '(set — leave blank to keep)' : '(none)'}`} compact>
                <input
                  id={`service-key-${service.id}`}
                  type="password"
                  autoComplete="off"
                  value={draft.apiKey}
                  onChange={set('apiKey')}
                  placeholder={service.hasCredentials ? 'Unchanged' : 'Not set'}
                  className={INPUT_CLASS}
                />
              </FormField>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => onSave(service, draft)} className="px-3 py-1.5 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50">
              Save service
            </button>
            {definition && (
              <button type="button" disabled={busy} onClick={() => onRefresh(service)} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-port-border text-gray-200 hover:text-white disabled:opacity-50">
                <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh catalog
              </button>
            )}
            {service.hasCredentials && (
              <button type="button" disabled={busy} onClick={() => onClearKey(service)} className="px-3 py-1.5 text-sm rounded-lg border border-port-border text-gray-200 hover:text-white disabled:opacity-50">
                Clear key
              </button>
            )}
            {presets.length === 0 && !confirmingDelete && (
              <button type="button" disabled={busy} onClick={() => setConfirmingDelete(true)} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-port-error/50 text-port-error hover:bg-port-error/10 disabled:opacity-50">
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Delete
              </button>
            )}
          </div>
          {confirmingDelete && (
            <InlineConfirmRow
              question={`Delete the ${serviceName(service)} service? Its endpoint, catalog and saved key go with it.`}
              confirmText="Delete service"
              autoFocus
              aria-label={`Confirm deleting the ${serviceName(service)} service`}
              onConfirm={() => { setConfirmingDelete(false); onDelete(service); }}
              onCancel={() => setConfirmingDelete(false)}
            />
          )}

          {/* Local-daemon readiness is computed per PRESET; `subject` is the
              first derived preset on this instance, standing for the daemon
              they all share. Same wiring as the preset card. */}
          {subject && readiness && (
            <ProviderReadiness
              readiness={readiness}
              onAutoSetup={(setup) => onAutoSetup?.({ ...setup, providerId: subject.id })}
              onUseServedModel={(modelId) => onUseServedModel?.(subject, modelId)}
              onServeWantedModel={onServeWantedModel ? () => onServeWantedModel(subject) : undefined}
              serving={Boolean(servingModel?.[subject.id])}
              optional={!service.enabled}
            />
          )}

          {service.catalog?.models?.length > 0 && (
            <p className="text-xs text-gray-400">
              Catalog: {service.catalog.models.slice(0, 6).map((model) => (typeof model === 'string' ? model : model?.id)).join(', ')}
              {service.catalog.models.length > 6 ? ` +${formatCount(service.catalog.models.length - 6)}` : ''}
            </p>
          )}

          <div>
            <h4 className="text-xs uppercase tracking-wide text-gray-500 mb-1">
              Presets on this service ({formatCount(presets.length)})
            </h4>
            {presets.length === 0 ? (
              <p className="text-xs text-gray-500">
                None yet — use Create preset on this card, or compose one from the{' '}
                <Link to="/ai/presets" className="text-port-accent hover:underline">Presets view</Link>.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {presets.map((preset) => (
                  <li key={preset.id}>
                    <Link to={presetEditPath(preset.id)} className="text-xs px-2 py-1 rounded bg-port-bg border border-port-border text-gray-200 hover:border-port-accent">
                      {preset.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * @param {object} props
 * @param {string|null} props.selectedServiceSlug - from `/ai/services/:serviceSlug` (slug or UUID); opened and scrolled to.
 * @param {boolean} props.creating - `/ai/services/new`: the add drawer is open.
 * @param {object[]} props.presets - the page's provider list, for "presets on this service" and the readiness subject.
 * @param {object} props.readiness - the page's local-daemon readiness map, keyed by preset id.
 * @param {function} [props.onAutoSetup] - the page's readiness handlers, as the preset card takes them.
 * @param {function} [props.onUseServedModel]
 * @param {function} [props.onServeWantedModel]
 * @param {object} [props.servingModel] - preset id → relaunch in flight.
 * @param {function} props.onChanged - a service write may re-materialize derived presets; the page reloads them.
 * @param {function} [props.onCreatePreset] - open the page compose flow seeded with this service.
 */
export default function ProviderServicesTab({
  selectedServiceSlug = null, creating = false, presets = [], readiness = {},
  onAutoSetup, onUseServedModel, onServeWantedModel, servingModel = {}, onChanged, onCreatePreset,
}) {
  const navigate = useNavigate();
  const [services, setServices] = useState(null); // null = not loaded
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState({});
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');

  const load = useCallback(async () => {
    const data = await api.getProviderServices({ silent: true }).catch((err) => ({ err }));
    if (data?.err) {
      setLoadError(data.err.message || 'Could not load the services.');
      return;
    }
    setLoadError(null);
    setServices(Array.isArray(data?.services) ? data.services : []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const presetsByService = useMemo(() => {
    const map = {};
    for (const preset of presets) {
      if (!preset.serviceId) continue;
      (map[preset.serviceId] ||= []).push(preset);
    }
    return map;
  }, [presets]);

  const presetCountOf = useCallback((service) => (presetsByService[service?.slug] || []).length, [presetsByService]);

  const organized = useMemo(() => {
    const loaded = services || [];
    const matched = loaded.filter((service) => serviceMatchesQuery(service, query));
    const counts = { all: matched.length };
    for (const entry of SERVICE_CATEGORIES) counts[entry.id] = 0;
    for (const service of matched) counts[classifyServiceCategory(service)] += 1;
    const inCategory = category === 'all'
      ? matched
      : matched.filter((service) => classifyServiceCategory(service) === category);
    const ordered = sortServices(inCategory, sort, presetCountOf);
    const groups = SERVICE_CATEGORIES
      .map((entry) => ({
        ...entry,
        services: ordered.filter((service) => classifyServiceCategory(service) === entry.id),
      }))
      .filter((group) => group.services.length > 0);
    return { counts, groups, shown: ordered.length };
  }, [services, query, category, sort, presetCountOf]);

  const selected = useMemo(() => (services || []).find((service) => service.slug === selectedServiceSlug || service.id === selectedServiceSlug) || null, [services, selectedServiceSlug]);
  useEffect(() => {
    if (services === null || !selectedServiceSlug || selected) return;
    toast.error(`No service with id "${selectedServiceSlug}"`);
    navigate('/ai/services', { replace: true });
  }, [services, selectedServiceSlug, selected, navigate]);

  const select = useCallback((slug) => navigate(slug ? `/ai/services/${encodeURIComponent(slug)}` : '/ai/services', { replace: true }), [navigate]);

  /** One write, then the row the server returns replaces ours and every picker re-reads the catalog. */
  const write = async (service, label, work, { reloadPresets = false } = {}) => {
    const key = service.id;
    setBusy((prev) => ({ ...prev, [key]: true }));
    const result = await work().catch((err) => ({ err }));
    setBusy((prev) => ({ ...prev, [key]: false }));
    if (result?.err) {
      toast.error(result.err.message || `${label} failed.`);
      return null;
    }
    if (result?.service) setServices((current) => (current || []).map((row) => (row.id === result.service.id ? result.service : row)));
    invalidateProviderCatalog();
    if (reloadPresets) onChanged?.();
    return result;
  };

  const handleToggle = async (service, enabled) => {
    const result = await write(service, enabled ? 'Enabling' : 'Disabling', () => api.updateProviderService(
      serviceRef(service), { expectedRevision: service.revision, enabled }, { silent: true },
    ));
    if (result) toast.success(`${serviceName(service)} ${enabled ? 'enabled' : 'disabled'}`);
  };

  const handleRefresh = async (service) => {
    const result = await write(service, 'Refreshing the catalog', () => api.refreshProviderServiceCatalog(serviceRef(service), { silent: true }), { reloadPresets: true });
    if (!result?.service) return;
    const { catalog } = result.service;
    if (catalog.state === 'failed') toast.error(catalog.error || 'The catalog refresh failed — the previous catalog was kept.');
    else toast.success(`${pluralize(catalog.models.length, 'model')} listed for ${serviceName(service)}`);
  };

  const handleSave = async (service, draft) => {
    const transports = transportsFromDraft(draft.transports);
    const result = await write(service, 'Saving the service', () => api.updateProviderService(serviceRef(service), {
      expectedRevision: service.revision,
      label: draft.label,
      ...(Object.keys(transports).length > 0 ? { transports } : {}),
      ...(draft.apiKey.trim() ? { credentials: { apiKey: draft.apiKey.trim() } } : {}),
    }, { silent: true }), { reloadPresets: true });
    if (result) toast.success(`${serviceName(result.service)} saved — every preset derived from it follows`);
  };

  const handleClearKey = async (service) => {
    const result = await write(service, 'Clearing the key', () => api.updateProviderService(
      serviceRef(service), { expectedRevision: service.revision, credentials: { apiKey: null } }, { silent: true },
    ), { reloadPresets: true });
    if (result) toast.success('Key cleared on this service and every preset derived from it.');
  };

  const handleDelete = async (service) => {
    const result = await write(service, 'Deleting the service', () => api.deleteProviderService(serviceRef(service), { silent: true }));
    if (!result) return;
    setServices((current) => (current || []).filter((row) => row.id !== service.id));
    toast.success(`${serviceName(service)} deleted`);
    select(null);
  };

  const handleCreated = (service) => {
    setServices((current) => [...(current || []), service]);
    invalidateProviderCatalog();
    navigate(`/ai/services/${encodeURIComponent(serviceRef(service))}`, { replace: true });
  };

  return (
    <div className="space-y-4">
      {loadError && (
        <Banner tone="error" size="md" title="Failed to load services" actions={(
          <button type="button" onClick={load} className="px-3 py-1.5 rounded-lg text-xs bg-port-error/20 hover:bg-port-error/30 text-port-error font-medium">Retry</button>
        )}>
          {loadError}
        </Banner>
      )}
      {services === null && !loadError && <p className="text-sm text-gray-400">Loading services…</p>}
      {services?.length === 0 && (
        <EmptyState
          title="No services yet"
          message="A service is a backend a harness can be pointed at — a hosted API you hold a key for, a local runtime, or a subscription the harness signs into. Add one, then any enabled harness can compose a run on it."
          actionLabel="Add service"
          onAction={() => navigate('/ai/services/new')}
        />
      )}
      {services?.length > 0 && (
        <div className="space-y-4">
          <div role="group" aria-label="Filter services by category" className="flex flex-wrap gap-2">
            {[{ id: 'all', label: 'All' }, ...SERVICE_CATEGORIES].map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={category === entry.id}
                onClick={() => setCategory(entry.id)}
                className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${category === entry.id ? 'border-port-accent bg-port-accent/15 text-white' : 'border-port-border text-gray-300 hover:text-white'}`}
              >
                <span>{entry.label}</span>
                <span className="text-gray-400">{formatCount(organized.counts[entry.id] || 0)}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label htmlFor="service-search" className="mb-1 block text-xs text-gray-400">Search</label>
              <input
                id="service-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, slug, or definition"
                className={INPUT_CLASS}
              />
            </div>
            <div className="sm:w-48">
              <label htmlFor="service-sort" className="mb-1 block text-xs text-gray-400">Sort</label>
              <select id="service-sort" value={sort} onChange={(event) => setSort(event.target.value)} className={INPUT_CLASS}>
                <option value="name">Name</option>
                <option value="readiness">Readiness</option>
                <option value="presets">Preset count</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-400" aria-live="polite">
            Showing {formatCount(organized.shown)} {organized.shown === 1 ? 'service' : 'services'}
            {category !== 'all' ? ` in ${serviceCategoryById(category).label}` : ''}
          </p>
          {organized.groups.length === 0 && (
            <p className="text-sm text-gray-500">No services match this filter.</p>
          )}
          {organized.groups.map((group) => (
            <CollapsibleSection
              key={group.id}
              id={`service-category-${group.id}`}
              size="lg"
              defaultOpen
              buttonClassName="flex-wrap"
              bodyClassName="grid gap-4 pt-3 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]"
              label={(
                <span className="flex flex-wrap items-center gap-2">
                  <span>{group.label}</span>
                  <span className="text-xs text-gray-400">{formatCount(group.services.length)}</span>
                </span>
              )}
            >
              {group.services.map((service) => {
                const servicePresets = presetsByService[service.slug] || [];
                const subject = servicePresets.find((preset) => readiness[preset.id]) || null;
                return (
                  <ServiceCard
                    key={service.id}
                    service={service}
                    open={selected?.id === service.id}
                    busy={Boolean(busy[service.id])}
                    presets={servicePresets}
                    subject={subject}
                    readiness={subject ? readiness[subject.id] : null}
                    servingModel={servingModel}
                    onAutoSetup={onAutoSetup}
                    onUseServedModel={onUseServedModel}
                    onServeWantedModel={onServeWantedModel}
                    onSelect={select}
                    onToggle={handleToggle}
                    onRefresh={handleRefresh}
                    onSave={handleSave}
                    onClearKey={handleClearKey}
                    onDelete={handleDelete}
                    onCreatePreset={onCreatePreset}
                  />
                );
              })}
            </CollapsibleSection>
          ))}
        </div>
      )}
      {creating && (
        <ProviderServiceForm onClose={() => navigate('/ai/services')} onCreated={handleCreated} />
      )}
    </div>
  );
}
