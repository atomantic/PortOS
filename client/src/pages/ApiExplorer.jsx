import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import {
  Bot, Braces, CheckCircle2, Copy, ExternalLink, RadioTower, Search,
} from 'lucide-react';
import PageHeader from '../components/PageHeader';
import RouteTabsHeader from '../components/ui/RouteTabsHeader';
import BrailleSpinner from '../components/BrailleSpinner';
import { copyToClipboard } from '../lib/clipboard';
import * as api from '../services/api';

const ScalarReference = lazy(() => import('../components/api-explorer/ScalarReference'));

const TABS = [
  { id: 'catalog', label: 'API Catalog', to: '/api-reference/catalog' },
  { id: 'rest', label: 'REST Reference', to: '/api-reference/rest' },
  { id: 'events', label: 'Event API', to: '/api-reference/events' },
  { id: 'tools', label: 'Agent Tools', to: '/api-reference/tools' },
];

const VALID_TABS = new Set(TABS.map((tab) => tab.id));
const PAGE_SIZE = 100;

const METHOD_STYLE = {
  GET: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  POST: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  PUT: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  PATCH: 'text-violet-300 bg-violet-500/10 border-violet-500/30',
  DELETE: 'text-red-300 bg-red-500/10 border-red-500/30',
};

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-port-border bg-port-card px-3 py-2 min-w-0">
      <div className="text-xl font-bold text-white">{value ?? '—'}</div>
      <div className="text-xs font-medium text-gray-300">{label}</div>
      {hint && <div className="text-[11px] text-gray-500 truncate">{hint}</div>}
    </div>
  );
}

function CatalogView() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [method, setMethod] = useState('all');
  const [domain, setDomain] = useState('all');
  const [coverage, setCoverage] = useState('all');
  const [limit, setLimit] = useState(PAGE_SIZE);

  useEffect(() => {
    api.getApiCatalog({ silent: true }).then(setCatalog).catch((err) => setError(err.message));
  }, []);

  const filtered = useMemo(() => {
    if (!catalog?.operations) return [];
    const needle = query.trim().toLowerCase();
    return catalog.operations.filter((operation) =>
      (method === 'all' || operation.method === method)
      && (domain === 'all' || operation.domain === domain)
      && (coverage === 'all' || operation.contractStatus === coverage)
      && (!needle || `${operation.method} ${operation.path} ${operation.summary} ${operation.domain}`.toLowerCase().includes(needle)));
  }, [catalog, coverage, domain, method, query]);

  useEffect(() => { setLimit(PAGE_SIZE); }, [coverage, domain, method, query]);

  if (error) return <div className="p-6 text-port-error">API catalog unavailable: {error}</div>;
  if (!catalog) return <div className="p-6"><BrailleSpinner text="Loading API catalog" /></div>;

  return (
    <div className="p-3 sm:p-4 space-y-4 max-w-[1500px] mx-auto">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Stat label="HTTP operations" value={catalog.stats.operations} hint={`${catalog.stats.sourceFiles} route files`} />
        <Stat label="Domains" value={catalog.stats.domains} hint={`${catalog.stats.mounts} mounts`} />
        <Stat label="Modeled" value={catalog.stats.modeled} hint="Detailed schemas" />
        <Stat label="Generated" value={catalog.stats.generated} hint="Discoverable inventory" />
        <Stat label="Spec version" value="3.1" hint="OpenAPI" />
      </div>

      <div className="rounded-xl border border-port-border bg-port-card p-3 space-y-3">
        <div className="flex flex-col lg:flex-row gap-2">
          <label className="relative flex-1 min-w-0">
            <span className="sr-only">Search API operations</span>
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search method, path, summary, or domain"
              className="w-full rounded-lg border border-port-border bg-port-bg py-2 pl-9 pr-3 text-sm text-white"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Method
            <select value={method} onChange={(event) => setMethod(event.target.value)} className="rounded-lg border border-port-border bg-port-bg px-2 py-2 text-sm text-white">
              <option value="all">All</option>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Domain
            <select value={domain} onChange={(event) => setDomain(event.target.value)} className="max-w-52 rounded-lg border border-port-border bg-port-bg px-2 py-2 text-sm text-white">
              <option value="all">All domains</option>
              {catalog.domains.map((value) => <option key={value.id} value={value.id}>{value.label} ({value.operations})</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Contract
            <select value={coverage} onChange={(event) => setCoverage(event.target.value)} className="rounded-lg border border-port-border bg-port-bg px-2 py-2 text-sm text-white">
              <option value="all">All</option>
              <option value="modeled">Modeled</option>
              <option value="generated">Generated</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
          <span>{filtered.length.toLocaleString()} matching operations</span>
          <div className="flex items-center gap-3">
            <Link to="/settings/api-access" className="text-port-accent hover:underline">Configure external access</Link>
            <a href="/api/api-docs/internal/openapi.json" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-port-accent hover:underline">
              Open JSON <ExternalLink size={11} />
            </a>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-port-border overflow-hidden">
        <div className="divide-y divide-port-border">
          {filtered.slice(0, limit).map((operation) => (
            <div key={`${operation.method}-${operation.path}`} className="bg-port-card px-3 py-2.5 hover:bg-port-border/20">
              <div className="flex items-start gap-2">
                <span className={`mt-0.5 w-16 shrink-0 rounded border px-1.5 py-0.5 text-center text-[11px] font-bold ${METHOD_STYLE[operation.method] || 'text-gray-300 border-port-border'}`}>
                  {operation.method}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <code className="text-sm text-white break-all">{operation.path}</code>
                    <span className="rounded bg-port-bg px-1.5 py-0.5 text-[10px] text-gray-400">{operation.domainLabel}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${operation.contractStatus === 'modeled' ? 'bg-port-success/10 text-port-success' : 'bg-port-warning/10 text-port-warning'}`}>
                      {operation.contractStatus}
                    </span>
                    <span className="rounded bg-port-bg px-1.5 py-0.5 text-[10px] text-gray-400">{operation.sideEffect}</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{operation.summary} · {operation.access}</p>
                </div>
                <button type="button" onClick={() => copyToClipboard(`${operation.method} ${operation.path}`, 'Operation copied')} className="p-1.5 text-gray-500 hover:text-white" aria-label={`Copy ${operation.method} ${operation.path}`}>
                  <Copy size={13} />
                </button>
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div className="bg-port-card p-8 text-center text-sm text-gray-500">No operations match these filters.</div>}
        </div>
      </div>
      {limit < filtered.length && (
        <button type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)} className="block mx-auto rounded-lg border border-port-border bg-port-card px-4 py-2 text-sm text-white hover:border-port-accent">
          Show {Math.min(PAGE_SIZE, filtered.length - limit)} more
        </button>
      )}
    </div>
  );
}

function RestReferenceView() {
  const [surface, setSurface] = useState('internal');
  const url = surface === 'internal' ? '/api/api-docs/internal/openapi.json' : '/api/api-docs/openapi.json';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-port-border bg-port-card px-3 py-2">
        <div>
          <div className="text-sm font-medium text-white">{surface === 'internal' ? 'Complete internal surface' : 'Currently exposed public surface'}</div>
          <div className="text-xs text-gray-500">Read-only reference; request execution and Scalar Agent are disabled.</div>
        </div>
        <div role="group" aria-label="REST API surface" className="flex rounded-lg border border-port-border p-0.5">
          {['internal', 'public'].map((value) => (
            <button key={value} type="button" aria-pressed={surface === value} onClick={() => setSurface(value)} className={`rounded-md px-3 py-1.5 text-xs ${surface === value ? 'bg-port-accent text-black' : 'text-gray-400 hover:text-white'}`}>
              {value === 'internal' ? 'Internal' : 'Exposed'}
            </button>
          ))}
        </div>
      </div>
      <div className="portos-api-reference min-h-0 flex-1 overflow-auto bg-port-bg">
        <Suspense fallback={<div className="p-6"><BrailleSpinner text="Loading REST reference" /></div>}>
          <ScalarReference url={url} />
        </Suspense>
      </div>
    </div>
  );
}

function EventCatalogView() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [direction, setDirection] = useState('all');
  const [domain, setDomain] = useState('all');
  const [coverage, setCoverage] = useState('all');

  useEffect(() => {
    api.getSocketEventCatalog({ silent: true }).then(setCatalog).catch((err) => setError(err.message));
  }, []);

  const events = useMemo(() => {
    if (!catalog?.events) return [];
    const needle = query.trim().toLowerCase();
    return catalog.events.filter((event) =>
      (direction === 'all' || event.directions.includes(direction))
      && (domain === 'all' || event.domain === domain)
      && (coverage === 'all' || event.contractStatus === coverage)
      && (!needle || `${event.event} ${event.summary} ${event.domain}`.toLowerCase().includes(needle)));
  }, [catalog, coverage, direction, domain, query]);

  if (error) return <div className="p-6 text-port-error">Event catalog unavailable: {error}</div>;
  if (!catalog) return <div className="p-6"><BrailleSpinner text="Loading event catalog" /></div>;

  return (
    <div className="p-3 sm:p-4 space-y-4 max-w-[1500px] mx-auto">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Stat label="Socket.IO events" value={catalog.stats.events} hint={`${catalog.stats.sourceFiles} source files`} />
        <Stat label="Client → server" value={catalog.stats.clientToServer} hint="Commands and subscriptions" />
        <Stat label="Server → client" value={catalog.stats.serverToClient} hint="Progress and live state" />
        <Stat label="Modeled payloads" value={catalog.stats.modeled} hint="Runtime-backed schemas" />
        <Stat label="Spec version" value="3.0" hint="AsyncAPI" />
      </div>

      <div className="rounded-xl border border-port-border bg-port-card p-3 space-y-3">
        <div className="flex flex-col lg:flex-row gap-2">
          <label className="relative flex-1 min-w-0">
            <span className="sr-only">Search Socket.IO events</span>
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search event, summary, or domain" className="w-full rounded-lg border border-port-border bg-port-bg py-2 pl-9 pr-3 text-sm text-white" />
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Direction
            <select value={direction} onChange={(event) => setDirection(event.target.value)} className="rounded-lg border border-port-border bg-port-bg px-2 py-2 text-sm text-white">
              <option value="all">All</option>
              <option value="client-to-server">Client → server</option>
              <option value="server-to-client">Server → client</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Domain
            <select value={domain} onChange={(event) => setDomain(event.target.value)} className="max-w-52 rounded-lg border border-port-border bg-port-bg px-2 py-2 text-sm text-white">
              <option value="all">All domains</option>
              {catalog.domains.map((value) => <option key={value.id} value={value.id}>{value.label} ({value.events})</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Contract
            <select value={coverage} onChange={(event) => setCoverage(event.target.value)} className="rounded-lg border border-port-border bg-port-bg px-2 py-2 text-sm text-white">
              <option value="all">All</option>
              <option value="modeled">Modeled</option>
              <option value="generated">Generated</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
          <span>{events.length.toLocaleString()} matching events</span>
          <a href="/api/api-docs/asyncapi.json" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-port-accent hover:underline">Open AsyncAPI JSON <ExternalLink size={11} /></a>
        </div>
      </div>

      <div className="rounded-xl border border-port-border overflow-hidden divide-y divide-port-border">
        {events.map((event) => (
          <div key={event.event} className="bg-port-card px-3 py-3 hover:bg-port-border/20">
            <div className="flex items-start gap-3">
              <RadioTower size={15} className="mt-1 shrink-0 text-port-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-sm text-white break-all">{event.event}</code>
                  {event.directions.map((value) => <span key={value} className="rounded bg-port-bg px-1.5 py-0.5 text-[10px] text-gray-400">{value === 'client-to-server' ? 'client → server' : 'server → client'}</span>)}
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${event.contractStatus === 'modeled' ? 'bg-port-success/10 text-port-success' : 'bg-port-warning/10 text-port-warning'}`}>{event.contractStatus}</span>
                </div>
                <p className="mt-1 text-xs text-gray-500">{event.summary} · {event.domainLabel}</p>
                {Object.keys(event.payloadSchemas).length > 0 && (
                  <details className="mt-2 text-xs text-gray-500">
                    <summary className="cursor-pointer">Payload schema</summary>
                    <pre className="mt-2 overflow-x-auto rounded border border-port-border bg-port-bg p-3 text-[11px] text-gray-300">{JSON.stringify(event.payloadSchemas, null, 2)}</pre>
                  </details>
                )}
              </div>
              <button type="button" onClick={() => copyToClipboard(event.event, 'Event copied')} className="p-1.5 text-gray-500 hover:text-white" aria-label={`Copy ${event.event}`}><Copy size={13} /></button>
            </div>
          </div>
        ))}
        {events.length === 0 && <div className="bg-port-card p-8 text-center text-sm text-gray-500">No events match these filters.</div>}
      </div>
    </div>
  );
}

function AgentToolsView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.getCosToolCatalog({ scope: 'mind', silent: true }),
      api.getCosToolCatalog({ scope: 'agent', silent: true }),
      api.getPersistentMindTools({ silent: true }),
      api.getSettings({ silent: true }),
    ]).then(([catalog, agentCatalog, authority, settings]) =>
      setData({ catalog, agentCatalog, authority, agentContext: settings.agentContext || {} })).catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="p-6 text-port-error">Agent tool catalog unavailable: {error}</div>;
  if (!data) return <div className="p-6"><BrailleSpinner text="Loading agent tools" /></div>;

  const { catalog, agentCatalog, authority, agentContext } = data;
  const agentToolsByName = new Map(agentCatalog.tools.map((tool) => [tool.name, tool]));

  return (
    <div className="p-3 sm:p-4 space-y-4 max-w-5xl mx-auto">
      <div className="rounded-xl border border-port-border bg-port-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-white"><Bot size={18} /><h2 className="font-semibold">Semantic tool catalog</h2></div>
            <p className="mt-1 text-sm text-gray-500">{catalog.stats.total} governed actions adapt PortOS services without exposing a raw HTTP proxy.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {['portos', 'openai', 'anthropic', 'mcp'].map((format) => (
              <a key={format} href={`/api/cos/tools?scope=mind&format=${format}`} target="_blank" rel="noreferrer" className="rounded border border-port-border px-2 py-1 text-port-accent hover:border-port-accent">
                {format}
              </a>
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-port-border bg-port-card p-4">
          <h3 className="text-sm font-medium text-white">Persistent Mind adapter</h3>
          <p className="mt-1 text-xs text-gray-500">Process-local multi-round tool loop. {catalog.stats.granted} of {catalog.stats.total} actions granted.</p>
          <Link to="/cos/tools" className="mt-2 inline-flex items-center gap-1 text-xs text-port-accent hover:underline">Configure Mind grants <ExternalLink size={11} /></Link>
        </div>
        <div className="rounded-xl border border-port-border bg-port-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-white">CoS Agent MCP</h3>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${agentContext.enabled ? 'bg-port-success/10 text-port-success' : 'bg-port-bg text-gray-500'}`}>{agentContext.enabled ? 'enabled' : 'disabled'}</span>
          </div>
          <p className="mt-1 text-xs text-gray-500">Loopback-only Streamable HTTP. {agentCatalog.stats.granted} of {agentCatalog.stats.total} semantic actions granted, plus bounded context tools.</p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            <Link to="/settings/api-access" className="text-port-accent hover:underline">Configure MCP grants</Link>
            <a href="/api/agent-context/manifest" target="_blank" rel="noreferrer" className="text-port-accent hover:underline">Open manifest</a>
          </div>
        </div>
      </div>
      {catalog.tools.map((tool) => (
        <div key={tool.name} className="rounded-xl border border-port-border bg-port-card p-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-port-accent">{tool.name}</code>
            <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${tool.granted ? 'bg-port-success/10 text-port-success' : 'bg-port-bg text-gray-500'}`}>
              {tool.granted && <CheckCircle2 size={11} />}Mind: {tool.granted ? 'granted' : 'disabled'}
            </span>
            {agentToolsByName.has(tool.name) ? (
              <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${agentToolsByName.get(tool.name).granted ? 'bg-port-success/10 text-port-success' : 'bg-port-bg text-gray-500'}`}>
                {agentToolsByName.get(tool.name).granted && <CheckCircle2 size={11} />}CoS MCP: {agentToolsByName.get(tool.name).granted ? 'granted' : 'disabled'}
              </span>
            ) : <span className="rounded bg-port-bg px-2 py-0.5 text-xs text-gray-500">Mind-only</span>}
            <span className="rounded bg-port-bg px-2 py-0.5 text-xs text-gray-500">{tool.policy.sideEffect}</span>
            <span className="rounded bg-port-bg px-2 py-0.5 text-xs text-gray-500">{tool.providerName}</span>
          </div>
          <p className="text-sm text-gray-400">{tool.description}</p>
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer">Input contract</summary>
            <pre className="mt-2 overflow-x-auto rounded border border-port-border bg-port-bg p-3 text-[11px] text-gray-300">{JSON.stringify(tool.input_schema, null, 2)}</pre>
          </details>
        </div>
      ))}
      <div className="rounded-xl border border-port-warning/30 bg-port-warning/5 p-4">
        <h3 className="text-sm font-medium text-port-warning">Hard boundaries</h3>
        <ul className="mt-2 list-disc pl-5 text-xs text-gray-400 space-y-1">
          {authority.boundaries.map((boundary) => <li key={boundary}>{boundary}</li>)}
        </ul>
      </div>
      <Link to="/cos/tools" className="inline-flex items-center gap-1 text-sm text-port-accent hover:underline">Configure Mind Tools <ExternalLink size={13} /></Link>
    </div>
  );
}

export default function ApiExplorer() {
  const { tab = 'catalog' } = useParams();
  const navigate = useNavigate();

  if (!VALID_TABS.has(tab)) return <Navigate to="/api-reference/catalog" replace />;

  return (
    <div className="h-full min-h-0 flex flex-col bg-port-bg">
      <PageHeader
        icon={Braces}
        title="API Explorer"
        subtitle="PortOS HTTP, event, and semantic agent contracts"
        actions={<button type="button" onClick={() => navigate('/settings/api-access')} className="text-xs text-port-accent hover:underline">API access settings</button>}
      />
      <RouteTabsHeader tabs={TABS} activeTab={tab} ariaLabel="API Explorer sections" />
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto">
        {tab === 'catalog' && <CatalogView />}
        {tab === 'rest' && <RestReferenceView />}
        {tab === 'events' && <EventCatalogView />}
        {tab === 'tools' && <AgentToolsView />}
      </div>
    </div>
  );
}
