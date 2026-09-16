import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, Pause, Play, Radio, Trash2, Zap } from 'lucide-react';
import {
  installEidoverseController,
  listEidoverseControllers,
  retireEidoverseController,
  setEidoverseControllerArmed,
} from '../../services/api';
import { formatCount, formatDateShort, timeAgo } from '../../utils/formatters';

/**
 * The install/arm/retire surface for executable Eidoverse world controllers
 * (#7456, #7488) — following `EidoverseFoundationsPanel.jsx` closely, since
 * this is the same shape of surface (a listing plus an authoring form, both
 * reading a refusal verdict rather than trusting a generic error) against the
 * same kind of store.
 *
 * The server route reuses the EXACT projection the `eidoverse.controllers`
 * mind-tool group already returns (`describeControllerDefinitions()` /
 * `summarizeControllerInstall()`), so nothing here re-derives what "armed",
 * "delivering", or a tick outcome means — it only renders what the service
 * already decided.
 */

const silent = { silent: true };

const MS_PER_SECOND = 1000;

const fieldClass = 'mt-1 min-h-[42px] w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none';
const secondaryButton = 'inline-flex min-h-[40px] items-center justify-center rounded-lg border border-port-border px-3 py-2 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white disabled:cursor-wait disabled:opacity-50';
const primaryButton = 'inline-flex min-h-[40px] items-center justify-center rounded-lg bg-port-accent px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50';
const dangerButton = 'inline-flex min-h-[40px] items-center justify-center rounded-lg bg-port-error px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50';

const EMPTY_DRAFT = Object.freeze({
  id: '', controllerId: '', tickIntervalSeconds: '300', districtId: '', anchorEntityId: '',
  config: '{}', deliverEffects: false, note: '',
});

/**
 * Parse one JSON textarea. Returns a `{ value }` OR an `{ error }` — never a
 * bare `null`, because `null` and `{}` are both legitimate parses and
 * collapsing "did not parse" into one of them would submit the wrong body.
 */
function parseJsonObject(text, label) {
  const trimmed = text.trim();
  if (!trimmed) return { value: {} };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (reason) {
    return { error: `${label} is not valid JSON: ${reason.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: `${label} must be a JSON object.` };
  return { value: parsed };
}

/** What the install list needs to tell a user "is this thing alive, and did
 * it work" without reasoning over `lastTickOk`/`lastTickReason` itself. */
function TickOutcome({ install }) {
  if (install.lastTickOk === null) return <span className="text-gray-500">Never ticked yet</span>;
  if (install.lastTickOk) return <span className="text-port-success">Last tick ok</span>;
  return <span className="text-port-error">Last tick failed{install.lastTickReason ? `: ${install.lastTickReason}` : ''}</span>;
}

/**
 * A supervisor disarm carries a REASON; a human choosing to pause one never
 * does — rendering the reason verbatim, right beside the re-arm action, is
 * the whole point of this panel existing (#7488 acceptance).
 */
function DisarmedReason({ reason }) {
  if (!reason) return null;
  return (
    <p className="mt-2 flex items-start gap-2 rounded-lg border border-port-warning/40 bg-port-warning/5 p-2 text-sm text-port-warning" role="status">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>The supervisor disarmed this controller: {reason}</span>
    </p>
  );
}

function Verdict({ verdict }) {
  if (!verdict) return null;
  if (verdict.outcome === 'installed' || verdict.outcome === 'updated' || verdict.outcome === 'retired') {
    return <p className="mt-3 text-sm text-port-success" role="status">Done.</p>;
  }
  return (
    <div className="mt-3 rounded-lg border border-port-error/40 p-3 text-sm text-port-error" role="status">
      <p className="font-medium">Refused — nothing changed.</p>
      {verdict.reasons?.length > 0 && (
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
    </div>
  );
}

export default function EidoverseControllersPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get('controller');
  const [available, setAvailable] = useState([]);
  const [installs, setInstalls] = useState([]);
  const [counts, setCounts] = useState({ total: 0, armed: 0, delivering: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [rowVerdicts, setRowVerdicts] = useState({});
  const [retireArmedFor, setRetireArmedFor] = useState('');
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [installVerdict, setInstallVerdict] = useState(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const fieldId = useId();

  const applyListing = useCallback((listing) => {
    setAvailable(listing.available || []);
    setInstalls(listing.installs || []);
    setCounts(listing.counts || { total: 0, armed: 0, delivering: 0 });
  }, []);

  const refresh = useCallback(() => listEidoverseControllers(silent).then(applyListing), [applyListing]);

  useEffect(() => {
    let live = true;
    listEidoverseControllers(silent)
      .then((listing) => {
        if (!live) return;
        applyListing(listing);
        setLoadError('');
      })
      .catch((reason) => { if (live) setLoadError(reason?.message || 'Could not load controllers.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [applyListing]);

  const openController = useCallback((id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('controller', id);
      else next.delete('controller');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const toggleArmed = useCallback(async (install) => {
    setBusyId(install.id);
    const verdict = await setEidoverseControllerArmed(install.id, !install.armed, silent)
      .catch((reason) => ({ outcome: 'refused', install: null, reasons: [reason?.message || 'The request failed.'] }));
    setRowVerdicts((current) => ({ ...current, [install.id]: verdict }));
    await refresh().catch(() => {});
    setBusyId('');
  }, [refresh]);

  const retire = useCallback(async (id) => {
    setBusyId(id);
    setRetireArmedFor('');
    const verdict = await retireEidoverseController(id, silent)
      .catch((reason) => ({ outcome: 'refused', install: null, reasons: [reason?.message || 'The request failed.'] }));
    setRowVerdicts((current) => ({ ...current, [id]: verdict }));
    if (verdict.outcome === 'retired' && openId === id) openController('');
    await refresh().catch(() => {});
    setBusyId('');
  }, [refresh, openId, openController]);

  const chooseControllerId = useCallback((controllerId) => {
    const definition = available.find((entry) => entry.id === controllerId);
    setDraft((current) => ({
      ...current,
      controllerId,
      config: JSON.stringify(definition?.exampleConfig ?? {}, null, 2),
    }));
  }, [available]);

  const submitDraft = useCallback(async (event) => {
    event.preventDefault();
    const config = parseJsonObject(draft.config, 'Config');
    if (config.error) { setFormError(config.error); return; }
    const seconds = Number(draft.tickIntervalSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) { setFormError('Tick interval must be a positive number of seconds.'); return; }
    setFormError('');
    setSaving(true);
    const authoredId = draft.id.trim();
    const result = await installEidoverseController({
      id: authoredId,
      controllerId: draft.controllerId,
      tickIntervalMs: Math.round(seconds * MS_PER_SECOND),
      placement: {
        districtId: draft.districtId.trim() || null,
        anchorEntityId: draft.anchorEntityId.trim() || null,
      },
      config: config.value,
      deliverEffects: draft.deliverEffects,
      note: draft.note.trim() || null,
    }, silent).catch((reason) => ({ outcome: 'refused', install: null, reasons: [reason?.message || 'Could not install the controller.'] }));
    setSaving(false);
    setInstallVerdict(result);
    if (result.outcome !== 'installed') return;
    setDraft(EMPTY_DRAFT);
    await refresh().catch(() => {});
    openController(authoredId);
  }, [draft, refresh, openController]);

  const mutateDraft = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));

  const openInstall = useMemo(() => installs.find((entry) => entry.id === openId) || null, [installs, openId]);
  const draftDefinition = useMemo(() => available.find((entry) => entry.id === draft.controllerId) || null, [available, draft.controllerId]);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-port-border bg-port-card p-4">
        <h3 className="flex items-center gap-2 font-medium text-white">
          <Zap size={16} className="text-port-accent" aria-hidden="true" />
          What is ticking in your world
        </h3>
        <p className="mt-1 text-sm leading-6 text-gray-400">
          A controller is a small piece of behavior PortOS ships, run on a timer between your visits. Every tick is
          synchronous and cannot reach an AI provider — the only thing a controller can do is propose bookkeeping,
          a line of chat, or a construction operation, and only an <strong className="text-gray-200">armed</strong>{' '}
          install with delivery turned on ever reaches the world itself.
        </p>
        <p className="mt-3 text-sm text-gray-400">
          {formatCount(counts.total, { fallback: '0' })} installed · {formatCount(counts.armed, { fallback: '0' })} armed · {formatCount(counts.delivering, { fallback: '0' })} delivering to the world
        </p>
      </section>

      {loadError && (
        <p className="rounded-lg border border-port-error/40 bg-port-error/5 p-3 text-sm text-port-error" role="alert">{loadError}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-400" role="status">Loading controllers…</p>
      ) : installs.length === 0 ? (
        <p className="text-sm text-gray-400">No controllers installed yet. Install one from the registry below.</p>
      ) : (
        <ul className="space-y-3">
          {installs.map((install) => {
            const expanded = install.id === openId;
            const definition = available.find((entry) => entry.id === install.controllerId);
            return (
              <li key={install.id} className="rounded-xl border border-port-border bg-port-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-medium text-white">{install.id}</h4>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${install.armed ? 'border-port-success/40 bg-port-success/10 text-port-success' : 'border-port-border text-gray-400'}`}>
                        <Radio size={12} aria-hidden="true" />
                        {install.armed ? 'Armed' : 'Disarmed'}
                      </span>
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${install.deliverEffects ? 'border-port-accent/40 bg-port-accent/10 text-port-accent' : 'border-port-border text-gray-400'}`}>
                        {install.deliverEffects ? 'Delivers to the world' : 'Bookkeeping only'}
                      </span>
                      <span className="rounded-full border border-port-border px-2 py-0.5 text-xs text-gray-400">{install.controllerId}</span>
                    </div>
                    <p className="mt-1 text-sm text-gray-400">{definition?.summary || 'This install\'s registered controller is no longer shipped by this version.'}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      Every {Math.round(install.tickIntervalMs / MS_PER_SECOND)}s · tick {formatCount(install.tick, { fallback: '0' })}
                      {install.lastTickAt ? ` · last ${timeAgo(install.lastTickAt)}` : ''} · <TickOutcome install={install} />
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={secondaryButton} disabled={busyId === install.id} onClick={() => toggleArmed(install)}>
                      {install.armed ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                      {install.armed ? 'Disarm' : 'Arm'}
                    </button>
                    <button type="button" className={secondaryButton} onClick={() => openController(expanded ? '' : install.id)}>
                      {expanded ? 'Hide' : 'Details'}
                    </button>
                    {retireArmedFor === install.id ? (
                      <>
                        <button type="button" className={dangerButton} disabled={busyId === install.id} onClick={() => retire(install.id)}>Confirm retire</button>
                        <button type="button" className={secondaryButton} onClick={() => setRetireArmedFor('')}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" className={secondaryButton} onClick={() => setRetireArmedFor(install.id)}>
                        <Trash2 size={14} aria-hidden="true" />
                        Retire
                      </button>
                    )}
                  </div>
                </div>

                <DisarmedReason reason={install.disarmedReason} />
                <Verdict verdict={rowVerdicts[install.id]} />

                {expanded && (
                  <div className="mt-3 space-y-2 border-t border-port-border pt-3 text-sm">
                    {install.note && <p className="text-gray-400">Note: {install.note}</p>}
                    <p className="text-gray-400">
                      Installed {formatDateShort(install.installedAt)} by {install.installedBy} ·
                      {' '}{install.consecutiveFailures > 0 ? `${install.consecutiveFailures} consecutive failure(s)` : 'no consecutive failures'}
                    </p>
                    <p className="text-gray-400">Config:</p>
                    <pre className="max-h-32 overflow-auto rounded-lg bg-port-bg p-3 text-xs text-gray-300">{JSON.stringify(install.config ?? {}, null, 2)}</pre>
                    {install.recentEffects?.length > 0 && (
                      <>
                        <p className="text-gray-400">Recent effects:</p>
                        <ul className="space-y-1 text-xs text-gray-400">
                          {install.recentEffects.map((effect) => (
                            <li key={`${effect.at}-${effect.tick}`}>{effect.kind}: {effect.summary} <span className="text-gray-500">({timeAgo(effect.at)})</span></li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <details className="rounded-xl border border-port-border bg-port-card p-4" open={installs.length === 0}>
        <summary className="cursor-pointer font-medium text-white">Install a controller</summary>
        <form className="mt-4 space-y-3" onSubmit={submitDraft}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${fieldId}-id`} className="text-sm text-gray-300">Install id (lowercase slug)</label>
              <input id={`${fieldId}-id`} className={fieldClass} value={draft.id} onChange={mutateDraft('id')} required placeholder="tide-beacon" />
            </div>
            <div>
              <label htmlFor={`${fieldId}-controller`} className="text-sm text-gray-300">Controller</label>
              <select id={`${fieldId}-controller`} className={fieldClass} value={draft.controllerId} onChange={(event) => chooseControllerId(event.target.value)} required>
                <option value="">Choose a shipped controller…</option>
                {available.map((definition) => <option key={definition.id} value={definition.id}>{definition.title}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${fieldId}-interval`} className="text-sm text-gray-300">Tick interval (seconds)</label>
              <input id={`${fieldId}-interval`} type="number" min="60" step="1" className={fieldClass} value={draft.tickIntervalSeconds} onChange={mutateDraft('tickIntervalSeconds')} required />
            </div>
            <div>
              <label htmlFor={`${fieldId}-note`} className="text-sm text-gray-300">Note (optional)</label>
              <input id={`${fieldId}-note`} className={fieldClass} value={draft.note} onChange={mutateDraft('note')} />
            </div>
            <div>
              <label htmlFor={`${fieldId}-district`} className="text-sm text-gray-300">District id (optional)</label>
              <input id={`${fieldId}-district`} className={fieldClass} value={draft.districtId} onChange={mutateDraft('districtId')} />
            </div>
            <div>
              <label htmlFor={`${fieldId}-anchor`} className="text-sm text-gray-300">Anchor entity id (optional)</label>
              <input id={`${fieldId}-anchor`} className={fieldClass} value={draft.anchorEntityId} onChange={mutateDraft('anchorEntityId')} />
            </div>
          </div>
          {draftDefinition?.summary && (
            <p className="text-xs text-gray-500">{draftDefinition.summary}</p>
          )}
          <div>
            <label htmlFor={`${fieldId}-config`} className="text-sm text-gray-300">Config — this controller&apos;s own JSON shape</label>
            <textarea id={`${fieldId}-config`} rows={6} className={`${fieldClass} font-mono text-xs`} value={draft.config} onChange={mutateDraft('config')} />
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-port-border bg-port-bg p-3">
            <input type="checkbox" className="mt-1" checked={draft.deliverEffects} onChange={(event) => setDraft((current) => ({ ...current, deliverEffects: event.target.checked }))} />
            <span className="text-sm">
              <span className="font-medium text-white">Let this controller speak and build in the world on its own schedule</span>
              <span className="block text-gray-400">
                Off by default. Off, a tick can only keep its own notes. On, its <code>say</code> and <code>augment</code>{' '}
                effects reach the world unattended, every tick, with nobody reviewing them first.
              </span>
            </span>
          </label>
          {formError && <p className="text-sm text-port-error" role="alert">{formError}</p>}
          <Verdict verdict={installVerdict} />
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => { setDraft(EMPTY_DRAFT); setFormError(''); setInstallVerdict(null); }}>Clear</button>
            <button type="submit" className={primaryButton} disabled={saving}>{saving ? 'Installing…' : 'Install'}</button>
          </div>
        </form>
      </details>

      {openId && !openInstall && !loading && (
        <p className="text-sm text-gray-400" role="status">
          No controller is installed under &quot;{openId}&quot; on this install.
        </p>
      )}
    </div>
  );
}
