/**
 * The OPTIONAL five-stage character evolution lens, as an editor (#6441).
 *
 * ONE component for every authoring surface — the FableLoom series plan's
 * "Cast evolution" section, the Pipeline series character-arc cards, and the
 * Writers Room cast bible (#6445) — because the lens shape is shared and a
 * second hand-written copy would drift the moment a stage field or an anchor
 * vocabulary moved. What differs between the hosts is only which evidence
 * anchors they own, and that already has a single source of truth in
 * `EVOLUTION_EVIDENCE_FIELDS`; the `host` prop selects which anchor row to
 * render.
 *
 * Three rules this surface must never break, carried from epic #6418:
 *   - The lens is OPTIONAL and never a gate. Nothing here blocks a save, marks
 *     an unset lens as a defect, or requires a stage before another one.
 *   - A declared `flat-testing` / `tragic-refusal` outcome is a first-class
 *     ending, not a finding — the outcome picker states that in its hint copy
 *     and renders no warning for either.
 *   - World-level psychology (`characters[].psychology`, #6414) is the BASELINE
 *     and is read-only here. It renders as collapsed reference context, and the
 *     only place it can be edited stays `universe/CharacterDetailEditor.jsx`.
 *
 * A stale anchor — a pointer to an episode / scene / transition that no longer
 * resolves — is preserved, marked, and given a one-click clear so it can be
 * re-picked. It must never silently vanish and must never read as satisfied.
 */

import { AlertTriangle } from 'lucide-react';
import FormField from '../ui/FormField';
import {
  CHARACTER_EVOLUTION_LIMITS,
  EVOLUTION_OUTCOMES,
  EVOLUTION_OUTCOME_HINTS,
  EVOLUTION_STAGES,
  EVOLUTION_STAGE_EDITOR_FIELDS,
  EVOLUTION_STAGE_LABELS,
  evolutionEvidenceStatus,
  evolutionStage,
  patchEvolution,
  patchEvolutionEvidence,
  patchEvolutionStage,
} from '../../lib/characterEvolution.js';
import { CHARACTER_PSYCHOLOGY_EDITOR_FIELDS } from '../../lib/characterFramework.js';

const inputClass = 'w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm';
const labelClass = 'block text-[11px] uppercase tracking-wider text-gray-500 mb-1';

const ids = (list) => new Set((list || []).map((item) => item?.id).filter(Boolean));

// Which reference sets the host can resolve an anchor against. Mirrors
// `characterArcEvidenceRefs` / `fableLoomEvolutionEvidenceRefs` on the server,
// derived from the option lists the host already hands this editor so the two
// cannot disagree about what exists.
const evidenceRefsFor = (host, anchors) => {
  if (host === 'fableLoom') return { episodeIds: ids(anchors?.episodes), sceneKeys: ids(anchors?.scenes) };
  // Writers Room resolves ids only. The server additionally checks each stage's
  // `anchorQuote` against the passage its segment still holds (it has the draft
  // body; this editor has the outline). Staler than the server, never laxer —
  // an anchor this surface calls live can still come back `[stale]` from the
  // evaluate pass, which is the safe direction.
  if (host === 'writersRoom') return { segmentIds: ids(anchors?.segments) };
  return { transitionIds: ids(anchors?.transitions) };
};

/**
 * The anchor fields of one stage that no longer resolve, as a clearing patch.
 * Asked field-by-field rather than by reading a list of pointer names here, so
 * the set of resolvable anchors stays owned by `evolutionEvidenceStatus` — an
 * authored locator with nothing to resolve against (a free-text scene anchor,
 * an issue number) never reports stale and is therefore never cleared.
 */
const staleAnchorPatch = (evidence, refs) => Object.fromEntries(
  Object.entries(evidence || {})
    .filter(([field, value]) => value && evolutionEvidenceStatus({ [field]: value }, refs) === 'stale')
    .map(([field]) => [field, '']),
);

/**
 * A blank-first `<select>` that keeps an unresolvable value visible.
 *
 * A stale pointer is not in `options`, so a plain select would render blank and
 * quietly drop the author's evidence on the next edit. Re-adding it as a
 * "(missing)" option is what makes the staleness legible at the field itself.
 */
function AnchorSelect({ id, label, ariaLabel, value, options, emptyLabel, onChange }) {
  const missing = Boolean(value) && !options.some((option) => option.id === value);
  return (
    <FormField label={label} labelClassName={labelClass}>
      <select id={id} aria-label={ariaLabel} className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{emptyLabel}</option>
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        {missing ? <option value={value}>{value} (missing)</option> : null}
      </select>
    </FormField>
  );
}

/**
 * The universe-level psychology profile as READ-ONLY reference context.
 * Collapsed by default and explicitly labelled world-level, so an author sees
 * the baseline the story is testing without this surface ever becoming a second
 * place that identity can be edited.
 */
function UniverseBaseline({ psychology }) {
  const filled = CHARACTER_PSYCHOLOGY_EDITOR_FIELDS
    .map((field) => [field.label, String(psychology?.[field.name] || '').trim()])
    .filter(([, value]) => value);
  if (!filled.length) return null;
  return (
    <details className="rounded border border-port-border/60 bg-port-bg/40 p-2">
      <summary className="min-h-[32px] cursor-pointer text-[11px] uppercase tracking-wider text-gray-500">
        Universe baseline (read-only)
      </summary>
      <p className="mt-1 text-[11px] text-gray-500">
        The world-level psychology profile this story puts under test. Edit it in the Universe cast, not here.
      </p>
      <dl className="mt-2 space-y-1 text-xs">
        {filled.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[11px] text-gray-500">{label}</dt>
            <dd className="text-gray-300">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

// The anchors this host owns, rendered for one stage. Every control is
// individually clearable, so an author can drop a single pointer without
// dismantling the stage.
function StageEvidence({ host, anchors, idPrefix, stageId, stageLabel, evidence, onPatch }) {
  const named = (label) => `${stageLabel} — ${label}`;
  if (host === 'writersRoom') {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <AnchorSelect
          id={`${idPrefix}-${stageId}-segment`}
          label="Evidence segment"
          ariaLabel={named('Evidence segment')}
          value={evidence?.segmentId || ''}
          options={anchors?.segments || []}
          emptyLabel="No segment anchor"
          onChange={(segmentId) => onPatch({ segmentId })}
        />
        <FormField
          label="Anchor quote"
          hint="Segment numbers are rebuilt every save — a short verbatim quote is what keeps this stage pinned to the right passage."
          labelClassName={labelClass}
        >
          <input
            id={`${idPrefix}-${stageId}-quote`}
            aria-label={named('Anchor quote')}
            className={inputClass}
            value={evidence?.anchorQuote || ''}
            maxLength={CHARACTER_EVOLUTION_LIMITS.anchorQuote}
            placeholder="A few words from the passage"
            onChange={(event) => onPatch({ anchorQuote: event.target.value })}
          />
        </FormField>
      </div>
    );
  }
  if (host === 'fableLoom') {
    const episodes = anchors?.episodes || [];
    const scenes = (anchors?.scenes || [])
      .filter((scene) => !evidence?.episodeId || scene.episodeId === evidence.episodeId);
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <AnchorSelect
          id={`${idPrefix}-${stageId}-episode`}
          label="Evidence episode"
          ariaLabel={named('Evidence episode')}
          value={evidence?.episodeId || ''}
          options={episodes}
          emptyLabel="No episode anchor"
          onChange={(episodeId) => onPatch({ episodeId })}
        />
        <AnchorSelect
          id={`${idPrefix}-${stageId}-scene`}
          label="Evidence scene"
          ariaLabel={named('Evidence scene')}
          value={evidence?.sceneKey || ''}
          options={scenes}
          emptyLabel="No scene anchor"
          onChange={(sceneKey) => onPatch({ sceneKey })}
        />
      </div>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <AnchorSelect
        id={`${idPrefix}-${stageId}-transition`}
        label="Evidence beat"
        ariaLabel={named('Evidence beat')}
        value={evidence?.transitionId || ''}
        options={anchors?.transitions || []}
        emptyLabel="No transition beat"
        onChange={(transitionId) => onPatch({ transitionId })}
      />
      <FormField label="At issue" labelClassName={labelClass}>
        <input
          id={`${idPrefix}-${stageId}-issue`}
          aria-label={named('At issue')}
          type="number"
          min={0}
          max={CHARACTER_EVOLUTION_LIMITS.atIssue}
          className={inputClass}
          value={Number.isFinite(evidence?.atIssue) ? evidence.atIssue : ''}
          placeholder="#"
          onChange={(event) => {
            const parsed = parseInt(event.target.value, 10);
            // Clamp here rather than lean on `max`: on a number input `max` only
            // fails constraint validation on submit, and this editor has no
            // <form>, so an unclamped value would reach the wholesale series
            // PATCH and 400 the entire save (same reason the transition editor
            // beside it clamps).
            onPatch({
              atIssue: Number.isFinite(parsed)
                ? Math.min(Math.max(parsed, 0), CHARACTER_EVOLUTION_LIMITS.atIssue)
                : null,
            });
          }}
        />
      </FormField>
      <FormField label="Scene anchor" labelClassName={labelClass}>
        <input
          id={`${idPrefix}-${stageId}-anchor`}
          aria-label={named('Scene anchor')}
          className={inputClass}
          value={evidence?.atSceneAnchor || ''}
          maxLength={CHARACTER_EVOLUTION_LIMITS.atSceneAnchor}
          placeholder="Where in the issue"
          onChange={(event) => onPatch({ atSceneAnchor: event.target.value })}
        />
      </FormField>
    </div>
  );
}

export default function CharacterEvolutionLens({
  idPrefix, evolution, onChange, host = 'pipelineSeries', anchors, psychology,
}) {
  const refs = evidenceRefsFor(host, anchors);
  const outcomeId = `${idPrefix}-outcome`;
  const noteId = `${idPrefix}-outcome-note`;

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-500">
        Optional. Five stages of a belief under test — sparse is fine, and a deliberately
        flat or refused arc is a first-class ending, not a gap. Nothing here gates a save.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <FormField
          label="Declared outcome"
          hint={EVOLUTION_OUTCOME_HINTS[evolution?.outcome] || 'Declaring how the arc lands is what stops a review reading it as unfinished.'}
          labelClassName={labelClass}
        >
          <select
            id={outcomeId}
            className={inputClass}
            value={evolution?.outcome || ''}
            onChange={(event) => onChange(patchEvolution(evolution, { outcome: event.target.value }))}
          >
            <option value="">Not declared yet</option>
            {EVOLUTION_OUTCOMES.map((outcome) => <option key={outcome} value={outcome}>{outcome}</option>)}
          </select>
        </FormField>
        <FormField label="Outcome note" labelClassName={labelClass}>
          <input
            id={noteId}
            className={inputClass}
            value={evolution?.outcomeNote || ''}
            maxLength={CHARACTER_EVOLUTION_LIMITS.outcomeNote}
            placeholder="Why it lands that way"
            onChange={(event) => onChange(patchEvolution(evolution, { outcomeNote: event.target.value }))}
          />
        </FormField>
      </div>

      <UniverseBaseline psychology={psychology} />

      <ol className="space-y-2">
        {EVOLUTION_STAGES.map((stageId, index) => {
          const stage = evolutionStage(evolution, stageId);
          const stageLabel = EVOLUTION_STAGE_LABELS[stageId];
          const stale = evolutionEvidenceStatus(stage?.evidence, refs) === 'stale';
          const patchEvidence = (patch) => onChange(patchEvolutionEvidence(evolution, stageId, patch));
          return (
            <li key={stageId} className="rounded border border-port-border p-2 bg-port-bg/40">
              <div className="flex items-center justify-between gap-2">
                <h5 className="text-xs font-medium text-gray-300">{index + 1}. {stageLabel}</h5>
                {stale ? (
                  <span className="flex items-center gap-1 text-[11px] text-port-warning" role="status">
                    <AlertTriangle size={12} /> Stale anchor
                  </span>
                ) : null}
              </div>
              {stale ? (
                <div className="mt-1 flex flex-wrap items-center gap-2 rounded border border-port-warning/40 bg-port-warning/5 p-2">
                  <p className="text-[11px] text-gray-400">
                    This evidence points at something that no longer exists, so the stage stays unproven.
                  </p>
                  <button
                    type="button"
                    className="min-h-[32px] rounded border border-port-warning px-2 text-[11px] text-port-warning hover:bg-port-warning/10"
                    onClick={() => patchEvidence(staleAnchorPatch(stage.evidence, refs))}
                  >
                    Re-pick {stageLabel} anchor
                  </button>
                </div>
              ) : null}
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {EVOLUTION_STAGE_EDITOR_FIELDS.map((field) => (
                  <FormField key={field.name} label={field.label} labelClassName={labelClass}>
                    <textarea
                      id={`${idPrefix}-${stageId}-${field.name}`}
                      aria-label={`${stageLabel} — ${field.label}`}
                      rows={2}
                      className={inputClass}
                      value={stage?.[field.name] || ''}
                      maxLength={field.max}
                      placeholder={field.placeholder}
                      onChange={(event) => onChange(
                        patchEvolutionStage(evolution, stageId, { [field.name]: event.target.value }),
                      )}
                    />
                  </FormField>
                ))}
              </div>
              <div className="mt-2">
                <StageEvidence
                  host={host}
                  anchors={anchors}
                  idPrefix={idPrefix}
                  stageId={stageId}
                  stageLabel={stageLabel}
                  evidence={stage?.evidence}
                  onPatch={patchEvidence}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
