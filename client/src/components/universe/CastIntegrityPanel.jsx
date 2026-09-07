/**
 * Cast integrity review + selective augmentation (#6415).
 *
 * Three states in one modal, in the order the work actually happens:
 *
 *   1. **Completeness** — opened straight into the DETERMINISTIC report, which
 *      costs nothing. Every character is listed with an explicit status, so
 *      "passed" and "never looked at" can never read the same.
 *   2. **Review** — the semantic pass. The button names the provider, the model
 *      and how many characters the batch covers BEFORE it runs, because a click
 *      here spends provider budget (AGENTS.md: no unannounced provider calls).
 *   3. **Augment** — for the findings a model can actually repair. Proposals
 *      arrive as before/after pairs and are applied ONE CHECKBOX AT A TIME; a
 *      `contradictory` finding never offers the button, because only the author
 *      can decide which of two disagreeing fields is the wrong one.
 *
 * Nothing here is persisted. The report is derived on open and carries the
 * fingerprint of the cast it measured; applying a proposal against a character
 * that changed since returns 409 rather than overwriting the newer edit.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldCheck, Sparkles, X } from 'lucide-react';
import Modal from '../ui/Modal';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import useCharacterAugmentation from '../../hooks/useCharacterAugmentation';
import AugmentPreview from '../castIntegrity/AugmentPreview';
import {
  getUniverseCastIntegrity,
  reviewUniverseCastIntegrity,
  proposeCharacterAugmentation,
  applyCharacterAugmentation,
} from '../../services/apiUniverseBuilder';
import {
  DEPTH_META,
  DIMENSION_LABELS,
  FINDING_KIND_META,
  REVIEW_STATUS_META,
  castIntegrityPassed,
  findingIsRepairable,
  humanizeIntegrityField,
  incompleteCoverage,
} from '../../lib/characterIntegrity';

const TONE_CLASS = {
  emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  amber: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  rose: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
  slate: 'bg-port-bg text-gray-400 border-port-border',
};

const Badge = ({ tone, children, title }) => (
  <span
    title={title}
    className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${TONE_CLASS[tone] || TONE_CLASS.slate}`}
  >
    {children}
  </span>
);

export default function CastIntegrityPanel({ open, universeId, onClose, onUniverseChange }) {
  const mountedRef = useMounted();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // Findings the user ticked, by finding id — the augment batch.
  const [selected, setSelected] = useState(() => new Set());

  // The propose → tick → apply loop itself is shared with Writers Room; this
  // panel supplies only the two universe-scoped requests and what to do after.
  const {
    preview, accepted, proposing, applying, toggleField, discard: discardAugment, runPropose, runApply,
  } = useCharacterAugmentation({
    propose: useCallback(
      (characterId, fields) => proposeCharacterAugmentation(universeId, characterId, { fields }, { silent: true }),
      [universeId],
    ),
    apply: useCallback(
      (characterId, body) => applyCharacterAugmentation(universeId, characterId, body, { silent: true }),
      [universeId],
    ),
    onApplied: useCallback((result, applied) => {
      if (result.universe) onUniverseChange?.(result.universe);
      setSelected(new Set());
      // This character just changed, so every finding the open report holds
      // about it was measured against a version that no longer exists. Mark the
      // row STALE rather than re-deriving the whole report: a re-derive would
      // run the deterministic pass again and silently discard the semantic
      // review the user just paid for.
      setReport((prev) => (prev ? {
        ...prev,
        coverage: prev.coverage.map((c) => (
          c.characterId === applied.characterId ? { ...c, status: 'stale', semanticReviewed: false } : c
        )),
      } : prev));
    }, [onUniverseChange]),
  });

  const load = useCallback(async () => {
    setLoading(true);
    const result = await getUniverseCastIntegrity(universeId, {}, { silent: true })
      .catch((err) => { toast.error(err.message || 'Could not load the integrity report'); return null; });
    if (!mountedRef.current) return;
    setLoading(false);
    if (result) {
      setReport(result);
      setSelected(new Set());
      discardAugment();
    }
  }, [universeId, mountedRef, discardAugment]);

  useEffect(() => {
    if (!open || !universeId) return;
    load();
  }, [open, universeId, load]);

  const scope = report?.reviewScope;
  const findings = useMemo(() => report?.findings || [], [report]);
  const repairable = useMemo(() => findings.filter(findingIsRepairable), [findings]);
  const incomplete = useMemo(() => incompleteCoverage(report), [report]);
  const passed = castIntegrityPassed(report);

  // Augmentation is per character (one call, one fingerprint), so a mixed
  // selection would need N calls and N staleness checks. Keep it to one.
  const selectedCharacterIds = useMemo(() => {
    const ids = new Set();
    for (const f of repairable) if (selected.has(f.id)) ids.add(f.characterId);
    return [...ids];
  }, [repairable, selected]);

  const toggleFinding = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleReview = async () => {
    if (reviewing) return;
    setReviewing(true);
    const result = await reviewUniverseCastIntegrity(universeId, {}, { silent: true })
      .catch((err) => { toast.error(err.message || 'Cast review failed'); return null; });
    if (mountedRef.current) setReviewing(false);
    if (!result || !mountedRef.current) return;
    setReport(result);
    setSelected(new Set());
    const n = result.findings?.length || 0;
    toast.success(result.truncated
      ? `Reviewed ${result.reviewScope?.characterCount || 0} of the cast — ${n} finding${n === 1 ? '' : 's'}. ${result.reviewScope?.remainingCount || 0} still unreviewed.`
      : `Reviewed the cast — ${n} finding${n === 1 ? '' : 's'}`);
  };

  const handlePropose = () => {
    if (selectedCharacterIds.length !== 1) return;
    const characterId = selectedCharacterIds[0];
    const name = report?.coverage?.find((c) => c.characterId === characterId)?.characterName;
    const fields = repairable.filter((f) => selected.has(f.id) && f.characterId === characterId).map((f) => f.field);
    runPropose(characterId, name, fields);
  };

  const reviewLabel = scope?.providerId
    ? `Review ${scope.characterCount} character${scope.characterCount === 1 ? '' : 's'} with ${scope.providerName || scope.providerId}${scope.model ? ` · ${scope.model}` : ''}`
    : 'Review cast';

  return (
    <Modal open={open} onClose={onClose} size="3xl" ariaLabelledBy="cast-integrity-title">
      <div className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col min-h-0">
        <div className="flex items-start justify-between gap-3 p-4 border-b border-port-border">
          <div>
            <h2 id="cast-integrity-title" className="text-white text-sm font-semibold flex items-center gap-2">
              <ShieldCheck size={14} /> Cast integrity
            </h2>
            <p className="text-xs text-gray-500 mt-1 max-w-xl">
              Whether each character holds together — not just whether the fields are filled. The completeness pass below is free; the semantic review costs one provider call.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close cast integrity"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-500 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-4">
          {loading ? (
            <p className="text-xs text-gray-400 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Reading the cast…</p>
          ) : null}

          {!loading && report ? (
            <>
              <div className="flex flex-wrap items-center gap-2 justify-between">
                <p className="text-xs text-gray-400">
                  {passed
                    ? `All ${report.castCount} characters reviewed and clean.`
                    : `${findings.length} finding${findings.length === 1 ? '' : 's'} across ${report.castCount} character${report.castCount === 1 ? '' : 's'}.`}
                  {incomplete.length ? (
                    <span className="text-gray-500"> {incomplete.length} not fully reviewed.</span>
                  ) : null}
                </p>
                <button
                  type="button"
                  onClick={handleReview}
                  disabled={reviewing || !report.castCount}
                  title={scope?.remainingCount ? `${scope.remainingCount} character(s) beyond this batch stay unreviewed` : undefined}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent/15 hover:bg-port-accent/25 text-port-accent border border-port-accent/40 text-xs disabled:opacity-40"
                >
                  {reviewing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                  {reviewLabel}
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 text-left uppercase tracking-wider text-[10px]">
                      <th scope="col" className="py-1 pr-3 font-normal">Character</th>
                      <th scope="col" className="py-1 pr-3 font-normal">Status</th>
                      <th scope="col" className="py-1 pr-3 font-normal">Depth</th>
                      <th scope="col" className="py-1 font-normal">Findings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.coverage || []).map((row) => (
                      <tr key={row.characterId} className="border-t border-port-border/50">
                        <td className="py-1.5 pr-3 text-gray-200">{row.characterName || row.characterId}</td>
                        <td className="py-1.5 pr-3">
                          <Badge tone={REVIEW_STATUS_META[row.status]?.tone}>{REVIEW_STATUS_META[row.status]?.label || row.status}</Badge>
                        </td>
                        <td className="py-1.5 pr-3">
                          <Badge tone="slate" title={DEPTH_META[row.depth]?.hint}>{DEPTH_META[row.depth]?.label || row.depth}</Badge>
                        </td>
                        <td className="py-1.5 text-gray-400">{row.findingCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {findings.length ? (
                <div className="space-y-2">
                  <h3 className="text-xs uppercase tracking-wider text-gray-500">Findings</h3>
                  {findings.map((f) => {
                    const meta = FINDING_KIND_META[f.kind] || {};
                    const checkboxId = `integrity-finding-${f.id.replace(/[^a-zA-Z0-9]/g, '-')}`;
                    return (
                      <div key={f.id} className="rounded border border-port-border bg-port-bg p-2.5">
                        <div className="flex items-start gap-2">
                          {meta.repairable ? (
                            <input
                              type="checkbox"
                              id={checkboxId}
                              checked={selected.has(f.id)}
                              onChange={() => toggleFinding(f.id)}
                              aria-label={`Select ${humanizeIntegrityField(f.field)} on ${f.characterName || f.characterId} for augmentation`}
                              className="mt-0.5 accent-port-accent"
                            />
                          ) : <span className="w-3" aria-hidden="true" />}
                          <div className="min-w-0 flex-1">
                            <label htmlFor={meta.repairable ? checkboxId : undefined} className="flex flex-wrap items-center gap-1.5">
                              <span className="text-gray-200">{f.characterName || f.characterId}</span>
                              <span className="text-gray-500">·</span>
                              <span className="text-gray-400 font-mono text-[11px]">{humanizeIntegrityField(f.field)}</span>
                              <Badge tone={meta.tone} title={meta.hint}>{meta.label || f.kind}</Badge>
                              {f.dimension ? <Badge tone="slate">{DIMENSION_LABELS[f.dimension] || f.dimension}</Badge> : null}
                            </label>
                            <p className="text-gray-400 mt-1">{f.evidence}</p>
                            {f.suggestion ? <p className="text-gray-500 mt-1 italic">{f.suggestion}</p> : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {selected.size ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-port-border bg-port-bg p-2.5">
                  <p className="text-xs text-gray-400">
                    {selected.size} field{selected.size === 1 ? '' : 's'} selected
                    {selectedCharacterIds.length > 1
                      ? ' — augment runs one character at a time, so narrow the selection to a single character.'
                      : '.'}
                  </p>
                  <button
                    type="button"
                    onClick={handlePropose}
                    disabled={proposing || selectedCharacterIds.length !== 1}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent/15 hover:bg-port-accent/25 text-port-accent border border-port-accent/40 text-xs disabled:opacity-40"
                  >
                    {proposing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    Propose improvements
                  </button>
                </div>
              ) : null}

              <AugmentPreview
                preview={preview}
                accepted={accepted}
                applying={applying}
                onToggleField={toggleField}
                onDiscard={discardAugment}
                onApply={runApply}
              />
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
