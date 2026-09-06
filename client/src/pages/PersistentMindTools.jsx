import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';
import Banner from '../components/ui/Banner';
import PersistentMindTaskAccessControls from '../components/cos/PersistentMindTaskAccessControls';
import PersistentMindTaskModelAllowlistControls from '../components/cos/PersistentMindTaskModelAllowlistControls';

export default function PersistentMindTools({ onCapabilitiesChange, onSavingChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [capabilitiesSaving, setCapabilitiesSaving] = useState(false);
  const requestVersion = useRef(0);

  const load = useCallback(() => {
    const version = ++requestVersion.current;
    setLoading(true);
    api.getPersistentMindTools({ silent: true })
      .then((response) => {
        if (version !== requestVersion.current) return;
        setData(response);
        setError(null);
      })
      .catch((requestError) => {
        if (version === requestVersion.current) setError(requestError?.message || 'Could not load persistent mind tools');
      })
      .finally(() => {
        if (version === requestVersion.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const tools = Array.isArray(data?.tools) ? data.tools : [];
  const taskCatalog = data?.taskCatalog;
  const grantedCount = tools.filter((tool) => tool.granted === true).length;
  const handleCapabilitiesSavingChange = (saving) => {
    setCapabilitiesSaving(saving);
    onSavingChange?.(saving);
  };
  const updateCapabilities = (capabilities) => {
    requestVersion.current += 1;
    setData((current) => current ? {
      ...current,
      capabilities,
      taskCatalog: capabilities.createTasks && current.taskCatalog ? {
        ...current.taskCatalog,
        apps: (current.taskCatalog.apps || []).map((app) => ({
          ...app,
          granted: Array.isArray(capabilities.allowedAppIds) ? capabilities.allowedAppIds.includes(app.id) : true,
        })),
      } : null,
      semanticTools: (current.semanticTools || []).map((tool) => ({
        ...tool,
        granted: tool.policy.requiredCapabilities.every((capability) => capabilities[capability] === true),
      })),
      tools: (current.tools || []).map((tool) => ({
        ...tool,
        granted: capabilities[tool.capability] === true,
      })),
    } : current);
    onCapabilitiesChange?.(capabilities);
    if (capabilities.createTasks && !data?.taskCatalog) load();
    else if (!capabilities.createTasks) setLoading(false);
  };

  return (
    <div className="space-y-4">
          {error && <Banner tone="error" title="Tools unavailable">{error}. The last loaded state is preserved; retry when the connection recovers.</Banner>}

          {loading && !data ? (
            <div className="flex justify-center py-12"><BrailleSpinner text="Loading persistent mind tools" /></div>
          ) : data ? (
            <>
              <details className="rounded border border-port-border bg-port-card p-4">
                <summary className="cursor-pointer text-base font-semibold text-port-text">Executable tools ({data.semanticTools?.length || 0})</summary>
                <p className="mt-1 text-xs text-port-text-muted">The exact semantic actions available to this mind. Expand a tool to inspect its arguments.</p>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {(data.semanticTools || []).map((tool) => (
                    <details key={tool.name} className="min-w-0 rounded border border-port-border p-2 text-xs">
                      <summary className="cursor-pointer break-words font-medium text-port-text">{tool.name} · {tool.granted ? 'Granted' : 'Disabled'}</summary>
                      <p className="mt-2 text-port-text-muted">{tool.description}</p>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-port-text-muted">{JSON.stringify(tool.input_schema, null, 2)}</pre>
                    </details>
                  ))}
                </div>
              </details>
              <section aria-labelledby="tools-summary-heading" className="rounded border border-port-border bg-port-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 id="tools-summary-heading" className="flex items-center gap-2 text-base font-semibold text-port-text">
                      <ShieldCheck size={18} className="text-port-accent" aria-hidden="true" />
                      Access inventory
                    </h2>
                    <p className="mt-1 text-sm text-port-text-muted">
                      {grantedCount} of {tools.length} persistent-mind capabilities granted. Changes apply to the next eligible wake.
                    </p>
                  </div>
                  <button type="button" onClick={load} disabled={loading} className="inline-flex min-h-10 items-center gap-1.5 rounded border border-port-border px-3 text-sm text-port-text-muted hover:border-port-accent hover:text-port-accent disabled:opacity-50">
                    <RefreshCw size={15} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" /> Refresh
                  </button>
                </div>
              </section>

              <section aria-labelledby="authority-controls-heading" className="rounded border border-port-border bg-port-card p-4">
                <h2 id="authority-controls-heading" className="text-sm font-semibold uppercase tracking-wide text-port-text-muted">Authority controls</h2>
                <div className="mt-4">
                  <PersistentMindTaskAccessControls
                    capabilities={data.capabilities}
                    disabled={capabilitiesSaving}
                    taskCatalog={taskCatalog}
                    onSaved={updateCapabilities}
                    onSavingChange={handleCapabilitiesSavingChange}
                  />
                </div>
                <div className="mt-4">
                  <PersistentMindTaskModelAllowlistControls
                    capabilities={data.capabilities}
                    disabled={capabilitiesSaving}
                    onSaved={(capabilities) => {
                      updateCapabilities(capabilities);
                      load();
                    }}
                    onSavingChange={handleCapabilitiesSavingChange}
                  />
                </div>
              </section>

              {taskCatalog && (
                <section aria-labelledby="task-catalog-heading" className="rounded border border-port-border bg-port-card p-4">
                  <h2 id="task-catalog-heading" className="text-sm font-semibold uppercase tracking-wide text-port-text-muted">Available task filing choices</h2>
                  <p className="mt-1 text-sm text-port-text-muted">These are the current choices the mind receives when it uses the typed task action. Repository paths and credentials are never included. Use Managed app access above to change which apps are authorized.</p>
                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-port-text-muted">Target apps</h3>
                      <ul className="mt-2 space-y-2 text-sm text-port-text">
                        {(taskCatalog.apps || []).map((app) => (
                          <li key={app.id} className="rounded border border-port-border px-3 py-2">
                            <Link to={`/apps/${encodeURIComponent(app.id)}/automation`} className="text-port-accent hover:underline">{app.name}</Link>
                            <span className={`ml-2 rounded-full border px-2 py-0.5 text-[11px] ${app.granted === false ? 'border-port-border text-port-text-muted' : 'border-port-success/40 text-port-success'}`}>{app.granted === false ? 'Not authorized' : 'Authorized'}</span>
                            <span className="ml-2 text-xs text-port-text-muted">{app.planOnly ? 'Implementation or Plan & File Issue' : 'Implementation delivery'}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-port-text-muted">Coding providers, models, and effort</h3>
                      <ul className="mt-2 space-y-2 text-sm text-port-text">
                        {(taskCatalog.providers || []).map((provider) => (
                          <li key={provider.id} className="rounded border border-port-border px-3 py-2">
                            <div>{provider.name}</div>
                            {provider.models?.length ? provider.models.map((model) => (
                              <div key={model.id} className="mt-1 text-xs text-port-text-muted">
                                {model.id} · {model.efforts?.length ? model.efforts.join(', ') : 'provider default effort'}
                              </div>
                            )) : <div className="mt-1 text-xs text-port-text-muted">Provider default model and effort</div>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </section>
              )}

              <section aria-labelledby="tools-heading" className="space-y-3">
                <h2 id="tools-heading" className="text-sm font-semibold uppercase tracking-wide text-port-text-muted">Granted capabilities</h2>
                {tools.map((tool) => (
                  <article key={tool.id} className="rounded border border-port-border bg-port-card p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded ${tool.granted ? 'bg-port-success/15 text-port-success' : 'bg-port-border/50 text-port-text-muted'}`}>
                          {tool.granted ? <CheckCircle2 size={19} aria-hidden="true" /> : <LockKeyhole size={18} aria-hidden="true" />}
                        </span>
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-port-text">{tool.name}</h3>
                          <p className="mt-1 text-sm text-port-text-muted">{tool.description}</p>
                        </div>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${tool.granted ? 'border-port-success/40 text-port-success' : 'border-port-border text-port-text-muted'}`}>
                        {tool.granted ? 'Granted' : 'Off by default'}
                      </span>
                    </div>

                    {Array.isArray(tool.guardrails) && tool.guardrails.length > 0 && (
                      <div className="mt-4 rounded border border-port-border bg-port-bg/40 px-3 py-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-port-text-muted">Guardrails</p>
                        <ul className="mt-2 space-y-1 text-xs text-port-text-muted">
                          {tool.guardrails.map((guardrail) => <li key={guardrail}>• {guardrail}</li>)}
                        </ul>
                      </div>
                    )}
                  </article>
                ))}
              </section>

              <section aria-labelledby="boundaries-heading" className="rounded border border-port-border bg-port-card p-4">
                <h2 id="boundaries-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text">
                  <LockKeyhole size={16} className="text-port-warning" aria-hidden="true" />
                  Always outside the persistent mind's authority
                </h2>
                <ul className="mt-3 grid gap-2 text-sm text-port-text-muted sm:grid-cols-3">
                  {(data.boundaries || []).map((boundary) => <li key={boundary} className="rounded border border-port-border px-3 py-2">{boundary}</li>)}
                </ul>
              </section>
            </>
          ) : null}
    </div>
  );
}
