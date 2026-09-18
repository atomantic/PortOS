import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { GitFork, Globe2, Home, ShieldCheck } from 'lucide-react';
import {
  getEidoverseContributions,
  listEidoverseFoundations,
  packageEidoverseFoundationCandidate,
  promoteEidoverseFoundation,
  recordEidoverseFoundation,
} from '../../services/api';
import { formatDateShort, timeAgo } from '../../utils/formatters';

/**
 * The promote surface for Eidoverse world foundations (#7455).
 *
 * Three things the user cannot get from the API alone: which ownership layer
 * each foundation sits in, WHY a promote was refused, and the fact that
 * promoting runs the agent-free resilience assay rather than believing anyone.
 * Every refusal is rendered verbatim beside its foundation — the server returns
 * a 200 with `outcome: 'refused'` and a reason list precisely so this panel can
 * show what to fix instead of a generic failure.
 *
 * The authoring form is here rather than on its own page because a promote
 * panel with no way to record a foundation is empty on every fresh install.
 */

const silent = { silent: true };

const FOUNDATION_KINDS = ['schema', 'affordance', 'controller', 'district-template'];

const LAYERS = {
  vernacular: {
    label: 'Local',
    icon: Home,
    className: 'border-port-accent/40 bg-port-accent/10 text-port-accent',
    hint: 'This install\'s own. Nothing leaves until you promote it.',
  },
  baseline: {
    label: 'Shared baseline',
    icon: Globe2,
    className: 'border-port-success/40 bg-port-success/10 text-port-success',
    hint: 'Offered to the shared PortOS baseline. Your style layer stayed local.',
  },
};

const fieldClass = 'mt-1 min-h-[42px] w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none';
const secondaryButton = 'inline-flex min-h-[40px] items-center justify-center rounded-lg border border-port-border px-3 py-2 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white disabled:cursor-wait disabled:opacity-50';
const primaryButton = 'inline-flex min-h-[40px] items-center justify-center rounded-lg bg-port-accent px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50';

const EMPTY_DRAFT = Object.freeze({
  id: '', kind: 'affordance', title: '', summary: '', contributionId: '',
  body: '{\n  "affordance": {}\n}', style: '{}',
  requires: '', effects: '', license: '', notes: '',
  // `{ originInstanceId, foundationId }` once this draft builds on a peer's
  // inherited foundation — see `draftFromFoundation` (#7631).
  derivedFrom: null,
});

/** Slug cap in `foundationIdSchema`; a derived id is trimmed to fit. */
const FOUNDATION_ID_MAX = 64;
const DERIVED_ID_SUFFIX = '-derived';

/** Comma-separated authoring input as the array the disclosure schema wants. */
const splitList = (value) => value.split(',').map((entry) => entry.trim()).filter(Boolean);

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

/**
 * A new local id for a draft built on a peer's foundation. Keeping the
 * inherited id would re-author (or create) a LOCAL record under the same name,
 * which is how a peer's work used to end up promoted as this install's own.
 */
const derivedFoundationId = (id) => `${String(id).slice(0, FOUNDATION_ID_MAX - DERIVED_ID_SUFFIX.length)}${DERIVED_ID_SUFFIX}`;

/**
 * Load a foundation into the authoring form.
 *
 * For a LOCAL row this is a plain re-author: same id, same everything. For an
 * INHERITED row it is a DERIVATION (#7631) — a new local id plus the
 * `derivedFrom` edge naming what it was built on, which the server resolves
 * against the copy this install actually holds and publishes on the promote
 * envelope. Re-use stays one click; re-use that erases the origin does not
 * exist. The inherited `id` is deliberately not carried over: the acceptance
 * test for this change asserts exactly that.
 */
const draftFromFoundation = (foundation) => ({
  id: foundation.inheritance ? derivedFoundationId(foundation.id) : foundation.id,
  derivedFrom: foundation.inheritance
    ? { originInstanceId: foundation.inheritance.originInstanceId, foundationId: foundation.id }
    : null,
  kind: foundation.kind,
  title: foundation.title,
  summary: foundation.summary,
  contributionId: foundation.contributionId,
  body: JSON.stringify(foundation.body ?? {}, null, 2),
  style: JSON.stringify(foundation.style ?? {}, null, 2),
  requires: (foundation.disclosure?.requires || []).join(', '),
  effects: (foundation.disclosure?.effects || []).join(', '),
  license: foundation.disclosure?.license || '',
  notes: foundation.disclosure?.notes || '',
});

/**
 * A list-rendering key that stays unique even when a local vernacular
 * foundation and an inherited copy share the same human-readable `id` — the
 * ledger stores them under disjoint keys precisely so that can happen (#7461).
 * `openId` (the `?foundation=` URL param) stays plain-id on purpose: it is
 * documented, deliberate scope that a deep link cannot yet disambiguate the
 * two, matching the "run assay"/"promote" actions, which are never offered
 * for an inherited entry in the first place.
 */
const foundationRowKey = (foundation) => (foundation.inheritance
  ? `${foundation.inheritance.originInstanceId}:${foundation.id}`
  : foundation.id);

function LayerBadge({ layer }) {
  const meta = LAYERS[layer];
  if (!meta) return <span className="rounded-full border border-port-border px-2 py-0.5 text-xs text-gray-400">{layer || 'unknown layer'}</span>;
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.className}`} title={meta.hint}>
      <Icon size={12} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

/**
 * What a gate just decided, with its reasons rendered verbatim. A pass gets a
 * line too: "run the assay" with no visible answer reads as a no-op, and the
 * row's own state changes too quietly to serve as the confirmation.
 */
const VERDICT_HEADLINES = Object.freeze({
  promoted: 'Promoted to the shared baseline.',
  packaged: 'Every gate passed — promote candidate packaged.',
});

function Verdict({ verdict }) {
  if (!verdict) return null;
  const headline = VERDICT_HEADLINES[verdict.outcome];
  return (
    <div className={`mt-3 rounded-lg border p-3 text-sm ${headline ? 'border-port-success/40 text-port-success' : 'border-port-error/40 text-port-error'}`} role="status">
      <p className="font-medium">{headline || 'Refused — nothing moved.'}</p>
      {verdict.reasons?.length > 0 && (
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
    </div>
  );
}

/** A short, non-collapsible label for who's opaque instance/author identity a
 * lineage event carries — never a display name (#7461: provenance is
 * instance-id + coarse author kind only). */
function InheritedFromBadge({ inheritance }) {
  if (!inheritance) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-port-border bg-port-bg px-2 py-0.5 text-xs text-gray-400"
      title={`Pulled from instance ${inheritance.sourceInstanceId}, originally authored on ${inheritance.originInstanceId}`}
    >
      <GitFork size={12} aria-hidden="true" />
      Inherited
    </span>
  );
}

/** This install's own work, built on a peer's foundation — the opposite claim
 * to `InheritedFromBadge`'s, and the one that keeps attribution when somebody
 * re-uses what a peer promoted (#7631). */
function DerivedFromBadge({ derivedFrom }) {
  if (!derivedFrom) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-port-border bg-port-bg px-2 py-0.5 text-xs text-gray-400"
      title={`Built on "${derivedFrom.foundationId}" from instance ${derivedFrom.originInstanceId}`}
    >
      <GitFork size={12} aria-hidden="true" />
      Derived
    </span>
  );
}

const LINEAGE_COPY = Object.freeze({
  authored: (event) => `Authored (${event.authorKind || 'unknown'})`,
  inherited: (event) => `Inherited from instance ${event.originInstanceId}`,
  derived: (event) => `Derived from "${event.foundationId}" on instance ${event.originInstanceId}`,
  assayed: (event) => (event.pass ? 'Agent-free assay passed' : 'Agent-free assay failed'),
  packaged: () => 'Promote candidate packaged',
  promoted: () => 'Promoted to the shared baseline',
});

/** Proposal → commit → promote(/inherit), oldest first — a read-only
 * projection the server derives on every read; nothing here is stored. */
function LineageTimeline({ lineage }) {
  if (!lineage?.length) return null;
  return (
    <ol className="space-y-1 text-xs text-gray-400">
      {lineage.map((event) => (
        <li key={`${event.type}-${event.at}`} className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-gray-300">{(LINEAGE_COPY[event.type] || (() => event.type))(event)}</span>
          <span className="text-gray-500" title={formatDateShort(event.at)}>{timeAgo(event.at)}</span>
        </li>
      ))}
    </ol>
  );
}

export default function EidoverseFoundationsPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get('foundation');
  const [foundations, setFoundations] = useState([]);
  const [counts, setCounts] = useState({ vernacular: 0, baseline: 0, candidates: 0, inherited: 0 });
  const [contributions, setContributions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [verdicts, setVerdicts] = useState({});
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const fieldId = useId();

  const applyListing = useCallback((listing) => {
    setFoundations(listing.foundations || []);
    setCounts(listing.counts || { vernacular: 0, baseline: 0, candidates: 0, inherited: 0 });
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([listEidoverseFoundations(silent), getEidoverseContributions(silent)])
      .then(([listing, registry]) => {
        if (!live) return;
        applyListing(listing);
        // `null` means "never fetched" and renders as a plain text field; an
        // empty ARRAY means this install genuinely registers no contribution,
        // which is a different thing to tell the author.
        setContributions(registry.contributions || []);
        setLoadError('');
      })
      .catch((reason) => { if (live) setLoadError(reason?.message || 'Could not load foundations.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [applyListing]);

  const openFoundation = useCallback((id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('foundation', id);
      else next.delete('foundation');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  /**
   * One handler for both gated actions. They differ only in the endpoint and in
   * whether a pass moves the ownership layer, and both answer 200 with a
   * verdict — so the refusal rendering, the busy state, and the list refresh
   * are identical and belong in one place.
   */
  const runGate = useCallback(async (id, action) => {
    setBusyId(id);
    const verdict = await action(id, silent).catch((reason) => ({ outcome: 'refused', reasons: [reason?.message || 'The request failed.'] }));
    setVerdicts((current) => ({ ...current, [id]: verdict }));
    // The layer, the stored candidate, and the assay verdict all change here,
    // so re-read the list rather than patching a guess into local state.
    await listEidoverseFoundations(silent).then(applyListing).catch(() => {});
    setBusyId('');
  }, [applyListing]);

  const submitDraft = useCallback(async (event) => {
    event.preventDefault();
    const body = parseJsonObject(draft.body, 'Body');
    const style = parseJsonObject(draft.style, 'Style');
    const problem = body.error || style.error;
    if (problem) { setFormError(problem); return; }
    setFormError('');
    setSaving(true);
    // The id we authored, not one read back off the response: the route cannot
    // rename it (the schema pins it), and reaching into the response shape here
    // would turn a server-side change into a thrown handler.
    const authoredId = draft.id.trim();
    const saved = await recordEidoverseFoundation({
      id: authoredId,
      kind: draft.kind,
      title: draft.title.trim(),
      summary: draft.summary.trim(),
      contributionId: draft.contributionId.trim(),
      body: body.value,
      style: style.value,
      // Omitted rather than sent as `null` when absent: the field is optional
      // on the input schema, and an explicit `null` is the same thing to it.
      ...(draft.derivedFrom ? { derivedFrom: draft.derivedFrom } : {}),
      disclosure: {
        requires: splitList(draft.requires),
        effects: splitList(draft.effects),
        license: draft.license.trim() || null,
        notes: draft.notes.trim() || null,
      },
    }, silent).catch((reason) => { setFormError(reason?.message || 'Could not record the foundation.'); return null; });
    setSaving(false);
    if (!saved) return;
    setDraft(EMPTY_DRAFT);
    // Re-authoring clears the candidate and the verdict server-side; a stale
    // "Promoted" banner beside the new body would be a lie.
    setVerdicts((current) => ({ ...current, [authoredId]: null }));
    await listEidoverseFoundations(silent).then(applyListing).catch(() => {});
    openFoundation(authoredId);
  }, [applyListing, draft, openFoundation]);

  const mutateDraft = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));

  const openFoundationRecord = useMemo(
    () => foundations.find((entry) => entry.id === openId) || null,
    [foundations, openId],
  );

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-port-border bg-port-card p-4">
        <h3 className="flex items-center gap-2 font-medium text-white">
          <ShieldCheck size={16} className="text-port-accent" aria-hidden="true" />
          Local vernacular and the shared baseline
        </h3>
        <p className="mt-1 text-sm leading-6 text-gray-400">
          Everything you author here is <strong className="text-gray-200">local</strong>. Promoting offers a
          foundation&apos;s substance to the shared PortOS baseline so peers can inherit it — your palette, motifs,
          asset paths and placement never travel. PortOS runs the agent-free resilience assay itself before it
          publishes anything, and refuses outright (rather than redacting) a payload carrying machine identity,
          personal data or credentials.
        </p>
        <p className="mt-3 text-sm text-gray-400">
          {counts.vernacular} local · {counts.baseline} in the shared baseline · {counts.candidates} packaged
          {counts.inherited > 0 && ` · ${counts.inherited} inherited from peers`}
        </p>
      </section>

      {loadError && (
        <p className="rounded-lg border border-port-error/40 bg-port-error/5 p-3 text-sm text-port-error" role="alert">{loadError}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-400" role="status">Loading foundations…</p>
      ) : foundations.length === 0 ? (
        <p className="text-sm text-gray-400">No foundations yet. Record one below to start the promote path.</p>
      ) : (
        <ul className="space-y-3">
          {foundations.map((foundation) => {
            const expanded = foundation.id === openId;
            return (
              <li key={foundationRowKey(foundation)} className="rounded-xl border border-port-border bg-port-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-medium text-white">{foundation.title}</h4>
                      <LayerBadge layer={foundation.layer} />
                      <InheritedFromBadge inheritance={foundation.inheritance} />
                      <DerivedFromBadge derivedFrom={foundation.derivedFrom} />
                      <span className="rounded-full border border-port-border px-2 py-0.5 text-xs text-gray-400">{foundation.kind}</span>
                    </div>
                    <p className="mt-1 text-sm text-gray-400">{foundation.summary}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      Replayed as <code className="text-gray-400">{foundation.contributionId}</code>
                      {foundation.candidate ? ' · candidate packaged' : ''}
                      {foundation.assay ? (foundation.assay.pass ? ' · assay passed' : ' · assay failed') : ' · assay not run'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {/* A local copy of a peer's foundation is never packaged or
                        promoted from here — it is already the origin's candidate,
                        and promoting it would re-share another install's work as
                        this one's own (the server refuses it too). */}
                    {!foundation.inheritance && (
                      <>
                        <button
                          type="button"
                          className={secondaryButton}
                          disabled={busyId === foundation.id}
                          onClick={() => runGate(foundation.id, packageEidoverseFoundationCandidate)}
                        >
                          {busyId === foundation.id ? 'Running assay…' : 'Run assay'}
                        </button>
                        <button
                          type="button"
                          className={primaryButton}
                          disabled={busyId === foundation.id || foundation.layer === 'baseline'}
                          title={foundation.layer === 'baseline' ? 'Already offered to the shared baseline' : 'Run every gate and publish to the shared baseline'}
                          onClick={() => runGate(foundation.id, promoteEidoverseFoundation)}
                        >
                          Promote
                        </button>
                      </>
                    )}
                    <button type="button" className={secondaryButton} onClick={() => openFoundation(expanded ? '' : foundation.id)}>
                      {expanded ? 'Hide' : 'Details'}
                    </button>
                  </div>
                </div>

                <Verdict verdict={verdicts[foundation.id]} />

                {expanded && (
                  <div className="mt-3 space-y-2 border-t border-port-border pt-3 text-sm">
                    <div>
                      <p className="text-gray-400">
                        Provenance
                        {foundation.provenance?.authorKind && ` — authored by a ${foundation.provenance.authorKind}`}
                        {foundation.provenance?.originInstanceId && ` on instance ${foundation.provenance.originInstanceId}`}:
                      </p>
                      <LineageTimeline lineage={foundation.lineage} />
                    </div>
                    <p className="text-gray-400">
                      Promotable substance (<code>body</code>) — the only part a peer receives:
                    </p>
                    <pre className="max-h-48 overflow-auto rounded-lg bg-port-bg p-3 text-xs text-gray-300">{JSON.stringify(foundation.body, null, 2)}</pre>
                    <p className="text-gray-400">
                      Local style (<code>style</code>) — never packaged, never federated:
                    </p>
                    <pre className="max-h-32 overflow-auto rounded-lg bg-port-bg p-3 text-xs text-gray-300">{JSON.stringify(foundation.style, null, 2)}</pre>
                    <button type="button" className={secondaryButton} onClick={() => setDraft(draftFromFoundation(foundation))}>
                      {foundation.inheritance ? 'Build on this in the form below' : 'Load into the form below'}
                    </button>
                    {foundation.inheritance && (
                      <p className="text-xs text-gray-500">
                        Loads a new local id and records a derivation edge back to instance{' '}
                        {foundation.inheritance.originInstanceId}, which travels with the foundation if you
                        promote it. Saving this body unchanged as your own work is refused.
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <details className="rounded-xl border border-port-border bg-port-card p-4" open={foundations.length === 0}>
        <summary className="cursor-pointer font-medium text-white">Record a foundation</summary>
        <p className="mt-1 text-sm leading-6 text-gray-400">
          Reusing an existing id re-authors it, which clears its packaged candidate and its assay verdict —
          both described the previous body. A foundation already in the shared baseline returns to local when
          you edit it, so the new body can be promoted in its turn.
        </p>
        {draft.derivedFrom && (
          <p className="mt-3 rounded-lg border border-port-accent/40 bg-port-accent/5 p-3 text-sm text-gray-300" role="status">
            Building on <code className="text-gray-200">{draft.derivedFrom.foundationId}</code> from instance{' '}
            <code className="text-gray-200">{draft.derivedFrom.originInstanceId}</code>. Recording this keeps the
            edge back to that install, and promoting it publishes the edge rather than your name alone.
          </p>
        )}
        <form className="mt-4 space-y-3" onSubmit={submitDraft}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${fieldId}-id`} className="text-sm text-gray-300">Id (lowercase slug)</label>
              <input id={`${fieldId}-id`} className={fieldClass} value={draft.id} onChange={mutateDraft('id')} required placeholder="tide-beacon" />
            </div>
            <div>
              <label htmlFor={`${fieldId}-kind`} className="text-sm text-gray-300">Kind</label>
              <select id={`${fieldId}-kind`} className={fieldClass} value={draft.kind} onChange={mutateDraft('kind')}>
                {FOUNDATION_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${fieldId}-title`} className="text-sm text-gray-300">Title</label>
              <input id={`${fieldId}-title`} className={fieldClass} value={draft.title} onChange={mutateDraft('title')} required />
            </div>
            <div>
              <label htmlFor={`${fieldId}-contribution`} className="text-sm text-gray-300">Resilience-assay contribution</label>
              {contributions?.length ? (
                <select id={`${fieldId}-contribution`} className={fieldClass} value={draft.contributionId} onChange={mutateDraft('contributionId')} required>
                  <option value="">Choose a registered contribution…</option>
                  {contributions.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              ) : (
                <input id={`${fieldId}-contribution`} className={fieldClass} value={draft.contributionId} onChange={mutateDraft('contributionId')} required />
              )}
              {contributions?.length === 0 && (
                <p className="mt-1 text-xs text-port-warning">
                  This install registers no replayable contribution, so nothing can pass the promote gate yet.
                </p>
              )}
            </div>
          </div>
          <div>
            <label htmlFor={`${fieldId}-summary`} className="text-sm text-gray-300">Summary</label>
            <input id={`${fieldId}-summary`} className={fieldClass} value={draft.summary} onChange={mutateDraft('summary')} required />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${fieldId}-body`} className="text-sm text-gray-300">Body — the promotable substance</label>
              <textarea id={`${fieldId}-body`} rows={6} className={`${fieldClass} font-mono text-xs`} value={draft.body} onChange={mutateDraft('body')} />
            </div>
            <div>
              <label htmlFor={`${fieldId}-style`} className="text-sm text-gray-300">Style — stays on this install</label>
              <textarea id={`${fieldId}-style`} rows={6} className={`${fieldClass} font-mono text-xs`} value={draft.style} onChange={mutateDraft('style')} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${fieldId}-requires`} className="text-sm text-gray-300">Requires (comma separated)</label>
              <input id={`${fieldId}-requires`} className={fieldClass} value={draft.requires} onChange={mutateDraft('requires')} />
            </div>
            <div>
              <label htmlFor={`${fieldId}-effects`} className="text-sm text-gray-300">Effects (comma separated)</label>
              <input id={`${fieldId}-effects`} className={fieldClass} value={draft.effects} onChange={mutateDraft('effects')} />
            </div>
            <div>
              <label htmlFor={`${fieldId}-license`} className="text-sm text-gray-300">License</label>
              <input id={`${fieldId}-license`} className={fieldClass} value={draft.license} onChange={mutateDraft('license')} />
            </div>
            <div>
              <label htmlFor={`${fieldId}-notes`} className="text-sm text-gray-300">Disclosure notes</label>
              <input id={`${fieldId}-notes`} className={fieldClass} value={draft.notes} onChange={mutateDraft('notes')} />
            </div>
          </div>
          {formError && <p className="text-sm text-port-error" role="alert">{formError}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => { setDraft(EMPTY_DRAFT); setFormError(''); }}>Clear</button>
            <button type="submit" className={primaryButton} disabled={saving}>{saving ? 'Saving…' : 'Record locally'}</button>
          </div>
        </form>
      </details>

      {openId && !openFoundationRecord && !loading && (
        <p className="text-sm text-gray-400" role="status">
          No foundation is recorded under &quot;{openId}&quot; on this install.
        </p>
      )}
    </div>
  );
}
