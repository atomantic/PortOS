import { useCallback, useEffect, useRef, useState } from 'react';
import { LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';
import Banner from '../components/ui/Banner';
import PersistentMindRecipeLibrary from '../components/cos/PersistentMindRecipeLibrary';
import PersistentMindTaskAccessControls from '../components/cos/PersistentMindTaskAccessControls';
import PersistentMindTaskModelAllowlistControls from '../components/cos/PersistentMindTaskModelAllowlistControls';
import PersistentMindSandboxControls from '../components/cos/PersistentMindSandboxControls';
import PersistentMindToolExposureControls from '../components/cos/PersistentMindToolExposureControls';

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
  const managedApps = data?.managedApps;
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
      managedApps: (capabilities.createTasks || capabilities.fileIssues) && current.managedApps
        ? current.managedApps.map((app) => ({
          ...app,
          granted: Array.isArray(capabilities.allowedAppIds) ? capabilities.allowedAppIds.includes(app.id) : true,
        }))
        : null,
      semanticTools: (current.semanticTools || []).map((tool) => ({
        ...tool,
        granted: tool.recipe?.available !== false
          && tool.policy.requiredCapabilities.every((capability) => capabilities[capability] === true),
      })),
      tools: (current.tools || []).map((tool) => ({
        ...tool,
        granted: capabilities[tool.capability] === true,
      })),
    } : current);
    onCapabilitiesChange?.(capabilities);
    // The shared app roster arrives only after a task or issue grant is on.
    if ((capabilities.createTasks || capabilities.fileIssues) && !data?.managedApps) load();
    else if (!capabilities.createTasks && !capabilities.fileIssues) setLoading(false);
  };

  return (
    <div className="space-y-4">
          {error && <Banner tone="error" title="Tools unavailable">{error}. The last loaded state is preserved; retry when the connection recovers.</Banner>}

          {loading && !data ? (
            <div className="flex justify-center py-12"><BrailleSpinner text="Loading persistent mind tools" /></div>
          ) : data ? (
            <>
              <section aria-labelledby="tools-summary-heading" className="rounded border border-port-border bg-port-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 id="tools-summary-heading" className="flex items-center gap-2 text-base font-semibold text-port-text">
                      <ShieldCheck size={18} className="text-port-accent" aria-hidden="true" />
                      Access inventory
                    </h2>
                    <p className="mt-1 text-sm text-port-text-muted">
                      {grantedCount} of {tools.length} persistent-mind capabilities granted. Changes apply on the next wake.
                    </p>
                  </div>
                  <button type="button" onClick={load} disabled={loading} className="inline-flex min-h-10 items-center gap-1.5 rounded border border-port-border px-3 text-sm text-port-text-muted hover:border-port-accent hover:text-port-accent disabled:opacity-50">
                    <RefreshCw size={15} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" /> Refresh
                  </button>
                </div>
                <div className="mt-4">
                  <PersistentMindTaskAccessControls
                    capabilities={data.capabilities}
                    disabled={capabilitiesSaving}
                    managedApps={managedApps}
                    onSaved={updateCapabilities}
                    onSavingChange={handleCapabilitiesSavingChange}
                  />
                </div>
                <div className="mt-4 border-t border-port-border pt-4">
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
                <div className="mt-4">
                  <PersistentMindSandboxControls
                    capabilities={data.capabilities}
                    disabled={capabilitiesSaving}
                    onSaved={updateCapabilities}
                    onSavingChange={handleCapabilitiesSavingChange}
                  />
                </div>
                <PersistentMindToolExposureControls
                  capabilities={data.capabilities}
                  disabled={capabilitiesSaving}
                  onSaved={updateCapabilities}
                  onSavingChange={handleCapabilitiesSavingChange}
                />
              </section>

              <PersistentMindRecipeLibrary />

              <details className="rounded border border-port-border bg-port-card p-4">
                <summary className="cursor-pointer text-sm font-semibold text-port-text">Limits and schemas</summary>
                <div className="mt-4 space-y-4">
                  <section aria-labelledby="tools-heading" className="space-y-2">
                    <h2 id="tools-heading" className="text-xs font-semibold uppercase tracking-wide text-port-text-muted">Grant limits</h2>
                    {tools.map((tool) => (
                      <article key={tool.id} className="rounded border border-port-border p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <h3 className="text-sm font-semibold text-port-text">{tool.name}</h3>
                          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tool.granted ? 'border-port-success/40 text-port-success' : 'border-port-border text-port-text-muted'}`}>
                            {tool.granted ? 'Granted' : 'Off by default'}
                          </span>
                        </div>
                        {tool.description && <p className="mt-1 text-xs text-port-text-muted">{tool.description}</p>}
                        {Array.isArray(tool.guardrails) && tool.guardrails.length > 0 && (
                          <ul className="mt-2 space-y-1 text-xs text-port-text-muted">
                            {tool.guardrails.map((guardrail) => <li key={guardrail}>{guardrail}</li>)}
                          </ul>
                        )}
                      </article>
                    ))}
                  </section>

                  <section aria-labelledby="semantic-tools-heading">
                    <h2 id="semantic-tools-heading" className="text-xs font-semibold uppercase tracking-wide text-port-text-muted">Executable tools ({data.semanticTools?.length || 0})</h2>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      {(data.semanticTools || []).map((tool) => (
                        <details key={tool.name} className="min-w-0 rounded border border-port-border p-2 text-xs">
                          <summary className="cursor-pointer break-words font-medium text-port-text">
                            {tool.name} · {tool.granted ? 'Granted' : 'Disabled'}
                            {tool.family && (
                              <span className={`ml-2 rounded-full border px-2 py-0.5 text-[10px] font-normal normal-case ${tool.family === 'core' ? 'border-port-accent/40 text-port-accent' : 'border-port-border text-port-text-muted'}`}>
                                {tool.family === 'core' ? 'core' : `${tool.family} family`}
                              </span>
                            )}
                          </summary>
                          <p className="mt-2 text-port-text-muted">{tool.description}</p>
                          {tool.recipe && (
                            <div className="mt-2 rounded border border-port-border bg-port-bg p-2 text-port-text-muted">
                              <p>Saved recipe · revision {tool.recipe.revision}</p>
                              <p className="mt-1">Reads: {tool.recipe.underlyingTools?.join(', ') || 'unavailable'}</p>
                              {!tool.granted && tool.recipe.disabledReason && <p className="mt-1 text-port-warning">{tool.recipe.disabledReason}</p>}
                            </div>
                          )}
                          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-port-text-muted">{JSON.stringify(tool.input_schema, null, 2)}</pre>
                        </details>
                      ))}
                    </div>
                  </section>

                  <section aria-labelledby="boundaries-heading">
                    <h2 id="boundaries-heading" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-port-text-muted">
                      <LockKeyhole size={14} className="text-port-warning" aria-hidden="true" />
                      Always refused
                    </h2>
                    <ul className="mt-2 space-y-1 text-xs text-port-text-muted">
                      {(data.boundaries || []).map((boundary) => <li key={boundary}>{boundary}</li>)}
                    </ul>
                  </section>
                </div>
              </details>
            </>
          ) : null}
    </div>
  );
}
