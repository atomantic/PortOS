import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Link2, Link2Off, RefreshCw, Star, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import Drawer from '../Drawer';
import Banner from '../ui/Banner';
import EmptyState from '../EmptyState';
import * as api from '../../services/api';
import { harnessLabel } from '../../utils/providerHarnesses';
import {
  bindingModelOffer,
  catalogSummary,
  findConnectionGroup,
  groupGraphByConnection,
  staleSelectedModels,
} from '../../lib/providerManagement';

/**
 * Backend connection management (#6369) — the deep-linked surface over the
 * durable provider graph.
 *
 * The thing this screen exists to make possible: **edit one backend once**. A
 * Claude CLI route, a Claude TUI route and an OpenCode route pointed at the
 * same Ollama daemon share ONE connection row here, so its endpoint, its key
 * and its model catalog are typed, refreshed and narrowed in one place instead
 * of three that drift.
 *
 * Three rules the UI is built around, all of them server-enforced too:
 *
 *   - **Identity is never inferred.** Two connections are the same only when
 *     the server says they share an id. Linking is an explicit, previewed act.
 *   - **Nothing here grants execution.** Narrowing a catalog, renaming a
 *     binding and editing an endpoint change no route's enabled state and no
 *     mode's consent. Those stay on the route editor, one click away.
 *   - **A saved value is never hidden.** A pin the catalog no longer offers is
 *     shown as stale, not dropped.
 *
 * The selected connection lives in the URL (`/ai/connections/:connectionId`,
 * or `/ai/harnesses/:harnessId/connections/:connectionId`) so the open row is
 * shareable, bookmarkable and reachable from ⌘K and voice.
 */

/** A transports map edited as flat text, back to the wire shape. */
const transportsFromDraft = (draft) => Object.fromEntries(
  Object.entries(draft)
    .filter(([, baseUrl]) => baseUrl.trim().length > 0)
    .map(([protocol, baseUrl]) => [protocol, { baseUrl: baseUrl.trim() }]),
);

const draftFromTransports = (transports) => Object.fromEntries(
  Object.entries(transports || {}).map(([protocol, value]) => [protocol, value?.baseUrl || '']),
);

export default function ProviderConnections({
  open,
  connectionId = null,
  harnessId = null,
  onClose,
  onSelectConnection,
  onGraphChanged,
}) {
  const [graph, setGraph] = useState(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Edit drafts live here rather than in uncontrolled inputs so a reload of the
  // graph (after a refresh or a link) cannot silently discard a half-typed edit
  // without the code saying so.
  const [labelDraft, setLabelDraft] = useState('');
  const [transportDraft, setTransportDraft] = useState({});
  const [credentialDraft, setCredentialDraft] = useState('');
  const [linkTarget, setLinkTarget] = useState({});
  const [linkPreview, setLinkPreview] = useState(null);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    const next = await api.getProviderManagementGraph({ silent: true }).catch((err) => ({ err }));
    setLoading(false);
    if (next?.err) {
      // Only an explicit "no such API" downgrades the view. A 500 or an offline
      // server stays an error, or a working install would quietly lose its
      // management screen the first time a request failed.
      if (api.isManagementUnsupported(next.err)) {
        setUnsupported(true);
        setGraph(null);
        return;
      }
      setLoadError(next.err.message || 'Could not load the connection graph.');
      return;
    }
    setUnsupported(false);
    setLoadError(null);
    setGraph(next);
  }, []);

  useEffect(() => { if (open) loadGraph(); }, [open, loadGraph]);

  const groups = useMemo(() => groupGraphByConnection(graph), [graph]);
  const selected = useMemo(
    () => (connectionId ? findConnectionGroup(groups, connectionId) : null),
    [groups, connectionId],
  );

  // Re-seed the drafts when the selection or its revision moves — and ONLY
  // then, so a poll that changed nothing cannot wipe a half-typed edit.
  //
  // `id` + `revision` is a complete key, not a shortcut: the server bumps the
  // revision on every write to a connection row, so the label and transports
  // below cannot change without it changing too.
  // Read through a ref inside the effect: the connection OBJECT is a new
  // identity on every poll, so depending on it would re-seed (and wipe) the
  // drafts every few seconds. The ref carries the current values; the two
  // primitives decide when to apply them.
  const selectedId = selected?.connection.id ?? null;
  const selectedRevision = selected?.connection.revision ?? null;
  const connectionRef = useRef(null);
  connectionRef.current = selected?.connection ?? null;
  useEffect(() => {
    const connection = connectionRef.current;
    if (!connection) return;
    setLabelDraft(connection.label || '');
    setTransportDraft(draftFromTransports(connection.transports));
    setCredentialDraft('');
    setLinkPreview(null);
  }, [selectedId, selectedRevision]);

  // A deep link naming a connection this install does not have should say so
  // and fall back, not render an empty panel forever.
  useEffect(() => {
    if (loading || !graph || !connectionId || selected) return;
    toast.error(`No connection with id "${connectionId}"`);
    onSelectConnection(null);
  }, [loading, graph, connectionId, selected, onSelectConnection]);

  const run = useCallback(async (label, work) => {
    setBusy(true);
    const result = await work().catch((err) => ({ err }));
    setBusy(false);
    if (result?.err) {
      toast.error(result.err.message || `${label} failed.`);
      return null;
    }
    await loadGraph();
    onGraphChanged?.();
    return result;
  }, [loadGraph, onGraphChanged]);

  const saveConnection = useCallback(async () => {
    if (!selected) return;
    const credentials = credentialDraft.trim().length > 0
      ? { apiKey: credentialDraft.trim() }
      : undefined;
    const saved = await run('Saving the connection', () => api.updateProviderConnection(
      selected.connection.id,
      {
        expectedRevision: selected.connection.revision,
        label: labelDraft,
        transports: transportsFromDraft(transportDraft),
        ...(credentials ? { credentials } : {}),
      },
      { silent: true },
    ));
    if (saved) toast.success(`Saved — ${saved.affectedRouteIds.length} route(s) updated to match.`);
  }, [selected, labelDraft, transportDraft, credentialDraft, run]);

  const clearCredential = useCallback(async () => {
    if (!selected) return;
    const saved = await run('Clearing the credential', () => api.updateProviderConnection(
      selected.connection.id,
      { expectedRevision: selected.connection.revision, credentials: { apiKey: null } },
      { silent: true },
    ));
    if (saved) toast.success('Credential cleared on this backend and every route using it.');
  }, [selected, run]);

  const refreshModels = useCallback(async () => {
    if (!selected) return;
    const result = await run('Refreshing models', () =>
      api.refreshProviderConnectionModels(selected.connection.id, { silent: true }));
    if (!result) return;
    if (result.catalog.state === 'failed') {
      toast.error(result.catalog.error || 'The model refresh failed — the previous catalog was kept.');
      return;
    }
    toast.success(`${result.catalog.models.length} model(s) shared across ${selected.bindings.length} harness binding(s).`);
  }, [selected, run]);

  const saveBindingModels = useCallback(async (binding, selectedModels) => {
    const saved = await run('Saving the model selection', () => api.updateProviderBinding(
      binding.id,
      { expectedRevision: binding.revision, selectedModels },
      { silent: true },
    ));
    if (saved) toast.success('Model selection saved. Existing pins were left as they were.');
  }, [run]);

  const previewLink = useCallback(async (binding, targetConnectionId) => {
    if (!targetConnectionId) return;
    const target = findConnectionGroup(groups, targetConnectionId);
    const preview = await api.previewProviderBindingLink(
      binding.id,
      { targetConnectionId, expectedRevisions: { binding: binding.revision } },
      { silent: true },
    ).catch((err) => ({ err }));
    if (preview?.err) {
      toast.error(preview.err.message || 'Could not preview that link.');
      return;
    }
    setLinkPreview({
      ...preview,
      bindingId: binding.id,
      targetConnectionId,
      targetLabel: target?.connection.label || targetConnectionId,
    });
  }, [groups]);

  const applyLink = useCallback(async () => {
    if (!linkPreview) return;
    const applied = await run('Linking', () => api.linkProviderBinding(
      linkPreview.bindingId,
      { targetConnectionId: linkPreview.revisions ? linkPreview.targetConnectionId ?? undefined : undefined, expectedRevisions: linkPreview.revisions },
      { silent: true },
    ));
    if (applied) {
      setLinkPreview(null);
      toast.success(`Linked — ${applied.affectedRouteIds.length} route(s) now use that backend.`);
    }
  }, [linkPreview, run]);

  const unlink = useCallback(async (binding) => {
    const done = await run('Unlinking', () => api.unlinkProviderBinding(
      binding.id,
      { expectedRevisions: { binding: binding.revision } },
      { silent: true },
    ));
    if (done) toast.success('This harness now has its own copy. Route ids and pins are unchanged.');
  }, [run]);

  const removeConnection = useCallback(async (connection) => {
    const done = await run('Deleting the connection', () =>
      api.deleteProviderConnection(connection.id, { silent: true }));
    if (done) {
      toast.success('Connection deleted.');
      onSelectConnection(null);
    }
  }, [run, onSelectConnection]);

  const makeDefault = useCallback(async (providerId) => {
    const done = await run('Setting the system default', () => api.setActiveProvider(providerId));
    if (done) toast.success(`${providerId} is now the system default route.`);
  }, [run]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title="Backend connections"
      subtitle={harnessId ? `Scoped to ${harnessLabel(harnessId)}` : 'One backend, shared by every harness pointed at it'}
      closeLabel="Close connection management"
    >
      {unsupported && (
        <Banner tone="info">
          This PortOS server does not expose connection management. Provider routes are still fully
          editable from the provider list behind this panel.
        </Banner>
      )}
      {loadError && <Banner tone="error">{loadError}</Banner>}

      {!unsupported && !loadError && (
        <div className="space-y-4">
          {loading && <p className="text-sm text-port-muted">Loading connections…</p>}

          {!loading && groups.length === 0 && (
            <EmptyState
              title="No managed connections yet"
              message="Connections are imported from your existing provider routes the first time the graph runs. Configure a provider and it will appear here."
            />
          )}

          {groups
            .filter((group) => !harnessId
              || group.bindings.some((entry) => entry.binding.harnessId === harnessId))
            .map((group) => {
              const isOpen = group.connection.id === connectionId;
              const summary = catalogSummary(group.connection.catalog);
              return (
                <section key={group.connection.id} className="rounded-lg border border-port-border bg-port-card">
                  <button
                    type="button"
                    onClick={() => onSelectConnection(isOpen ? null : group.connection.id)}
                    aria-expanded={isOpen}
                    className="flex w-full flex-col gap-1 p-3 text-left sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{group.connection.label || group.connection.id}</span>
                      <span className="block text-xs text-port-muted">
                        {group.connection.kind}
                        {' · '}
                        {Object.entries(group.connection.transports)
                          .map(([protocol, value]) => `${protocol} ${value.baseUrl}`)
                          .join(' · ') || 'no endpoint declared'}
                        {group.connection.hasCredentials ? ' · key set' : ''}
                      </span>
                    </span>
                    <span className={`shrink-0 text-xs ${summary.tone === 'error' ? 'text-port-error' : summary.tone === 'ok' ? 'text-port-success' : 'text-port-muted'}`}>
                      {summary.text}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="space-y-4 border-t border-port-border p-3">
                      {summary.detail && <Banner tone="error">{summary.detail}</Banner>}

                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block text-sm" htmlFor={`conn-label-${group.connection.id}`}>
                          <span className="mb-1 block text-port-muted">Name</span>
                          <input
                            id={`conn-label-${group.connection.id}`}
                            className="w-full rounded border border-port-border bg-port-bg px-2 py-1"
                            value={labelDraft}
                            onChange={(e) => setLabelDraft(e.target.value)}
                          />
                        </label>
                        <label className="block text-sm" htmlFor={`conn-key-${group.connection.id}`}>
                          <span className="mb-1 block text-port-muted">
                            API key {group.connection.hasCredentials ? '(set — leave blank to keep)' : '(none)'}
                          </span>
                          <input
                            id={`conn-key-${group.connection.id}`}
                            type="password"
                            autoComplete="off"
                            className="w-full rounded border border-port-border bg-port-bg px-2 py-1"
                            value={credentialDraft}
                            onChange={(e) => setCredentialDraft(e.target.value)}
                            placeholder={group.connection.hasCredentials ? 'Unchanged' : 'Not set'}
                          />
                        </label>
                        {Object.entries(transportDraft).map(([protocol, baseUrl]) => (
                          <label key={protocol} className="block text-sm" htmlFor={`conn-${group.connection.id}-${protocol}`}>
                            <span className="mb-1 block text-port-muted">{protocol} endpoint</span>
                            <input
                              id={`conn-${group.connection.id}-${protocol}`}
                              className="w-full rounded border border-port-border bg-port-bg px-2 py-1"
                              value={baseUrl}
                              onChange={(e) => setTransportDraft((prev) => ({ ...prev, [protocol]: e.target.value }))}
                            />
                          </label>
                        ))}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={busy} onClick={saveConnection}
                          className="rounded bg-port-accent px-3 py-1 text-sm text-white disabled:opacity-50">
                          Save backend
                        </button>
                        <button type="button" disabled={busy} onClick={refreshModels}
                          className="flex items-center gap-1 rounded border border-port-border px-3 py-1 text-sm disabled:opacity-50">
                          <RefreshCw size={14} aria-hidden="true" /> Refresh models
                        </button>
                        {group.connection.hasCredentials && (
                          <button type="button" disabled={busy} onClick={clearCredential}
                            className="rounded border border-port-border px-3 py-1 text-sm disabled:opacity-50">
                            Clear key
                          </button>
                        )}
                        {group.bindings.length === 0 && (
                          <button type="button" disabled={busy} onClick={() => removeConnection(group.connection)}
                            className="flex items-center gap-1 rounded border border-port-error px-3 py-1 text-sm text-port-error disabled:opacity-50">
                            <Trash2 size={14} aria-hidden="true" /> Delete
                          </button>
                        )}
                      </div>

                      {group.bindings.map(({ binding, label, routes }) => {
                        const offer = bindingModelOffer(group.connection, binding);
                        const stale = staleSelectedModels(group.connection, binding);
                        const chosen = offer.filter((entry) => entry.selected).map((entry) => entry.model);
                        return (
                          <div key={binding.id} className="rounded border border-port-border p-3">
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                              <h4 className="font-medium">{label}</h4>
                              <span className="text-xs text-port-muted">
                                {binding.variantKey !== 'default' ? `${binding.variantKey} · ` : ''}
                                {routes.length} route{routes.length === 1 ? '' : 's'}
                              </span>
                            </div>

                            {binding.blocked && (
                              <Banner tone="warning">
                                This binding has an unresolved projection and cannot be changed until it settles.
                              </Banner>
                            )}

                            <ul className="mb-3 space-y-1">
                              {routes.map((route) => (
                                <li key={route.providerId} className="flex flex-wrap items-center gap-2 text-sm">
                                  <span className="rounded bg-port-bg px-1.5 py-0.5 text-xs uppercase">{route.mode}</span>
                                  <Link to={`/ai/edit/${route.providerId}`} className="text-port-accent hover:underline">
                                    {route.providerId}
                                  </Link>
                                  {graph?.activeProvider === route.providerId ? (
                                    <span className="flex items-center gap-1 text-xs text-port-success">
                                      <Star size={12} aria-hidden="true" /> system default
                                    </span>
                                  ) : (
                                    <button type="button" disabled={busy} onClick={() => makeDefault(route.providerId)}
                                      className="text-xs text-port-muted hover:underline disabled:opacity-50">
                                      Use as system default
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>

                            {offer.length > 0 && (
                              <fieldset className="mb-2">
                                <legend className="mb-1 text-xs text-port-muted">
                                  Models this harness offers (from the shared catalog)
                                </legend>
                                <div className="flex flex-wrap gap-2">
                                  {offer.map((entry) => (
                                    <label key={entry.model} className="flex items-center gap-1 text-sm"
                                      htmlFor={`model-${binding.id}-${entry.model}`}>
                                      <input
                                        id={`model-${binding.id}-${entry.model}`}
                                        type="checkbox"
                                        checked={entry.selected}
                                        disabled={busy || binding.blocked}
                                        onChange={(e) => saveBindingModels(
                                          binding,
                                          e.target.checked
                                            ? [...chosen, entry.model]
                                            : chosen.filter((model) => model !== entry.model),
                                        )}
                                      />
                                      {entry.model}
                                    </label>
                                  ))}
                                </div>
                              </fieldset>
                            )}

                            {stale.length > 0 && (
                              <p className="mb-2 text-xs text-port-warning">
                                Still selected but not in the current catalog: {stale.join(', ')} — kept as-is.
                              </p>
                            )}

                            <div className="flex flex-wrap items-center gap-2">
                              <label className="sr-only" htmlFor={`link-${binding.id}`}>Move this harness to another backend</label>
                              <select
                                id={`link-${binding.id}`}
                                className="rounded border border-port-border bg-port-bg px-2 py-1 text-sm"
                                value={linkTarget[binding.id] || ''}
                                disabled={busy || binding.blocked}
                                onChange={(e) => setLinkTarget((prev) => ({ ...prev, [binding.id]: e.target.value }))}
                              >
                                <option value="">Move to another backend…</option>
                                {groups
                                  .filter((candidate) => candidate.connection.id !== group.connection.id)
                                  .map((candidate) => (
                                    <option key={candidate.connection.id} value={candidate.connection.id}>
                                      {candidate.connection.label || candidate.connection.id}
                                    </option>
                                  ))}
                              </select>
                              <button type="button" disabled={busy || binding.blocked || !linkTarget[binding.id]}
                                onClick={() => previewLink(binding, linkTarget[binding.id])}
                                className="flex items-center gap-1 rounded border border-port-border px-3 py-1 text-sm disabled:opacity-50">
                                <Link2 size={14} aria-hidden="true" /> Preview
                              </button>
                              {group.bindings.length > 1 && (
                                <button type="button" disabled={busy || binding.blocked} onClick={() => unlink(binding)}
                                  className="flex items-center gap-1 rounded border border-port-border px-3 py-1 text-sm disabled:opacity-50">
                                  <Link2Off size={14} aria-hidden="true" /> Give it its own copy
                                </button>
                              )}
                            </div>

                            {linkPreview?.bindingId === binding.id && (
                              <div className="mt-2 rounded border border-port-accent p-2 text-sm">
                                <p className="mb-1">
                                  Moving <strong>{label}</strong> to <strong>{linkPreview.targetLabel}</strong> changes
                                  the backend for {linkPreview.affectedRouteIds.length} route(s):
                                  {' '}{linkPreview.affectedRouteIds.join(', ')}.
                                </p>
                                {linkPreview.differences.length > 0 && (
                                  <p className="mb-1 text-port-warning">
                                    The two backends differ in: {linkPreview.differences.join(', ')}.
                                  </p>
                                )}
                                <p className="mb-2 text-xs text-port-muted">
                                  Route ids, model pins, fallbacks and the system default are unchanged.
                                </p>
                                <div className="flex gap-2">
                                  <button type="button" disabled={busy} onClick={applyLink}
                                    className="rounded bg-port-accent px-3 py-1 text-sm text-white disabled:opacity-50">
                                    Apply link
                                  </button>
                                  <button type="button" onClick={() => setLinkPreview(null)}
                                    className="rounded border border-port-border px-3 py-1 text-sm">
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
        </div>
      )}
    </Drawer>
  );
}
