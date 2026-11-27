import { Check, Eye, Info, X } from 'lucide-react';
import { listThreejsClips } from '../../lib/threejsAnimation';
import { summarizeThreejsArticulation } from '../../lib/threejsRig';

const SEVERITY_STYLE = {
  error: 'border-port-error/40 bg-port-error/10 text-port-error',
  warning: 'border-port-warning/40 bg-port-warning/10 text-port-warning',
  note: 'border-port-border bg-port-bg/50 text-gray-400',
};

// Counted from the findings actually rendered rather than read off the stored
// tallies, so a header can never disagree with the list below it — or print
// "undefined error" for a record whose gate result arrived without its counts.
// An unrecognized severity counts as a note rather than being dropped: the list
// still renders it (styled as a note), and a tally that omitted it would read
// "0 note" above a visible finding.
const countSeverities = (findings) => findings.reduce((counts, finding) => {
  const bucket = counts[finding.severity] === undefined ? 'note' : finding.severity;
  counts[bucket] += 1;
  return counts;
}, { error: 0, warning: 0, note: 0 });

/**
 * One quality-gate result (assembly coverage, cross-section) rendered as a
 * severity-styled finding list. Shared so a second gate cannot drift into a
 * different look for the same data.
 */
// A finding that names a clip and a moment can be replayed in the preview.
const isReplayable = (finding) => Boolean(finding.clipId)
  && Number.isFinite(finding.timeSeconds)
  && Array.isArray(finding.partIds);

function GatePanel({ title, findings, cleanLabel, footer, children = null, onShowFinding = null }) {
  const counts = countSeverities(findings);
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">{title}</h2>
        <span className="text-xs text-gray-600">
          {findings.length === 0
            ? cleanLabel
            : `${counts.error} error · ${counts.warning} warning · ${counts.note} note`}
        </span>
      </div>
      {findings.length > 0 && (
        <ul className="space-y-2">
          {findings.map((finding, index) => (
            <li
              key={`${finding.code}-${index}`}
              className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${SEVERITY_STYLE[finding.severity] || SEVERITY_STYLE.note}`}
            >
              <span className="mr-2 text-[9px] uppercase tracking-wide opacity-80">{finding.severity}</span>
              {finding.message}
              {onShowFinding && isReplayable(finding) && (
                <button
                  type="button"
                  onClick={() => onShowFinding(finding)}
                  className="mt-2 flex items-center gap-1.5 rounded border border-current/40 px-2 py-1 text-[11px] hover:bg-white/5 pointer-coarse:min-h-11"
                >
                  <Eye className="h-3 w-3" /> Show in preview
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {children}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{footer}</span>
      </p>
    </section>
  );
}

const formatSeconds = (times) => times.map((time) => `${time}s`).join(', ');

/**
 * Which clip times the physical audit measured, and which its pose budget left
 * out — so a clean panel over an animated model says how much of the motion it
 * actually covers.
 */
function PoseCoverageList({ coverage }) {
  return (
    <div className="mt-3 text-[11px] leading-relaxed text-gray-500">
      <p className="mb-1">
        {coverage.status === 'partial'
          ? `Clip poses checked (the ${coverage.budget}-pose budget ran out):`
          : 'Clip poses checked:'}
      </p>
      <ul className="space-y-0.5">
        {coverage.clips.map((clip) => (
          <li key={clip.clipId} className="break-words">
            <span className="text-gray-400">{clip.clipName}</span>
            {' — '}
            {clip.sampledTimes.length > 0 ? formatSeconds(clip.sampledTimes) : 'none'}
            {clip.omittedCount > 0 && (
              <span className="text-port-warning">
                {`; ${clip.omittedCount} omitted (${formatSeconds(clip.omittedTimes)}${clip.omittedCount > clip.omittedTimes.length ? ', …' : ''})`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The chosen subject family's checklist, with each required component marked
 * resolved or unresolved by the coverage pass, plus the axes and orbit views
 * worth checking against the live preview above. Snapshotted onto the record at
 * generation time, so it always describes the spec on screen — not whatever the
 * taxonomy happens to say today.
 */
function FamilyChecklistPanel({ family }) {
  const missing = new Set(family.missing || []);
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">
          {family.label} checklist
        </h2>
        <span className="text-xs text-gray-600">
          {missing.size === 0
            ? 'Every expected component is accounted for'
            : `${missing.size} of ${family.components.length} unaccounted for`}
        </span>
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {family.components.map((component) => {
          const unresolved = missing.has(component);
          return (
            <li
              key={component}
              className={`flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                unresolved ? SEVERITY_STYLE.warning : 'border-port-border bg-port-bg/50 text-gray-300'
              }`}
            >
              {unresolved
                ? <X className="mt-0.5 h-3 w-3 shrink-0" />
                : <Check className="mt-0.5 h-3 w-3 shrink-0 text-port-success" />}
              <span>{component}</span>
            </li>
          );
        })}
      </ul>
      {family.reviewAxes?.length > 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
          <span className="text-gray-400">Judge it on:</span> {family.reviewAxes.join('; ')}.
        </p>
      )}
      {family.orbitViews?.length > 0 && (
        <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
          <span className="text-gray-400">Orbit the preview to:</span> {family.orbitViews.join(', ')}.
        </p>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          This list is a floor, not a ceiling — it is what this subject family is usually judged on,
          not the whole inventory. A component is marked accounted for when the spec names it
          anywhere, including a limitation explaining the reference does not show it.
        </span>
      </p>
    </section>
  );
}

/**
 * Static-versus-articulation-ready status for the generated spec, plus the
 * joint/pivot diagnostics behind it. Prefers the report the server wrote at
 * generation time; a record from before that shipped has none, and degrades to
 * an honest "static, and never evaluated" rather than borrowing a pass.
 */
function RigReadinessPanel({ rig, spec }) {
  const derived = summarizeThreejsArticulation(spec);
  const ready = rig ? rig.articulationReady === true : false;
  // A report that arrived without its counts (an older or newer peer, a
  // hand-repaired row) falls back to the spec rather than printing "undefined
  // joints" — the same rule the coverage panel applies to its tallies.
  const count = (key) => (Number.isFinite(rig?.[key]) ? rig[key] : derived[key]);
  const jointCount = count('jointCount');
  const socketCount = count('socketCount');
  const attachmentCount = count('attachmentCount');
  // A report written before anchors shipped carries no split, and inferring one
  // from the total would credit every legacy attachment as anchored — the exact
  // overstatement the split exists to remove. Fall back to the spec instead.
  const unanchoredAttachmentCount = count('unanchoredAttachmentCount');
  const reasons = Array.isArray(rig?.reasons) ? rig.reasons : [];
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">Rig readiness</h2>
        <span className={ready
          ? 'rounded bg-port-success/15 px-2 py-0.5 text-[10px] uppercase text-port-success'
          : 'rounded bg-port-border px-2 py-0.5 text-[10px] uppercase text-gray-400'}
        >
          {ready ? 'Articulation-ready' : 'Static assembly'}
        </span>
      </div>
      <p className="text-xs text-gray-400">
        {jointCount} joint{jointCount === 1 ? '' : 's'} · {socketCount} pivot socket{socketCount === 1 ? '' : 's'}
        {' · '}{attachmentCount} declared attachment{attachmentCount === 1 ? '' : 's'}
        {attachmentCount > 0 && ` (${attachmentCount - unanchoredAttachmentCount} anchored, ${unanchoredAttachmentCount} unanchored)`}
      </p>
      {!rig && (
        <p className="mt-2 rounded-lg border border-port-border bg-port-bg/50 px-3 py-2 text-xs leading-relaxed text-gray-400">
          This model was generated before rig readiness was reported, so it was never evaluated —
          regenerate it to get a verdict.
        </p>
      )}
      {reasons.length > 0 && (
        <ul className="mt-2 space-y-2">
          {reasons.map((reason) => (
            <li key={reason} className="rounded-lg border border-port-border bg-port-bg/50 px-3 py-2 text-xs leading-relaxed text-gray-400">
              {reason}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          PortOS builds static assemblies. Articulation is a declaration of what is meant to move —
          stable joint ids, one root, and a named pivot socket per joint — never a skeleton: nothing
          here is skinned, bound to a bind pose, or exported as a rigged mesh.
        </span>
      </p>
    </section>
  );
}

/**
 * What the spec declared it can PLAY. Prefers the inventory the server wrote at
 * generation time and falls back to the spec's own clips, so a model generated
 * before clips shipped reads as the static assembly it is rather than borrowing
 * a verdict it was never given.
 */
function ClipInventoryPanel({ animation, spec }) {
  const clips = Array.isArray(animation?.clips) && animation.clips.length > 0
    ? animation.clips
    : listThreejsClips(spec).map((clip) => ({
      id: clip.id,
      name: clip.name,
      role: clip.role,
      durationSeconds: clip.durationSeconds,
      sequenceCount: clip.sequences?.length || 0,
      cueCount: new Set((clip.sequences || []).map((sequence) => sequence.cueId).filter(Boolean)).size,
    }));
  if (clips.length === 0) return null;
  return (
    <section className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">Animation clips</h2>
        <span className="text-xs text-gray-600">
          {clips.length} clip{clips.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {clips.map((clip) => (
          <div key={clip.id} className="rounded-lg border border-port-border bg-port-bg/50 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-xs font-medium text-gray-200">{clip.name}</h3>
              <span className="rounded bg-port-border px-1.5 py-0.5 text-[9px] uppercase text-gray-400">{clip.role || 'custom'}</span>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {clip.durationSeconds}s · {clip.sequenceCount} sequence{clip.sequenceCount === 1 ? '' : 's'}
              {clip.cueCount > 0 ? ` · ${clip.cueCount} sound cue${clip.cueCount === 1 ? '' : 's'}` : ''}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          Clips are declared transforms over time, not a skeleton and not code — play or scrub them
          in the preview. Sound cues are identifiers only: PortOS ships no audio and plays none,
          and scrubbing never fires one.
        </span>
      </p>
    </section>
  );
}


function CollisionAndPhysicalPanels({ record, handleShowFinding }) {
  // A penetration result stored before clip poses were swept has no
  // `poseCoverage`; for a model that declares clips that is "never measured
  // while moving", said on screen rather than read as a clean panel.
  const penetrationPoseCoverage = Array.isArray(record.penetration?.poseCoverage?.clips)
    ? record.penetration.poseCoverage
    : null;
  const penetrationPosesUnrecorded = Array.isArray(record.penetration?.findings)
    && !penetrationPoseCoverage
    && listThreejsClips(record.spec).length > 0;
  const penetrationFindings = Array.isArray(record.penetration?.findings)
    ? [
      ...record.penetration.findings,
      ...(penetrationPosesUnrecorded ? [{
        code: 'clip-collisions-unrecorded',
        severity: 'note',
        message: 'This check predates clip-pose sweeping: parts were compared only in the resting pose, so a part could pass through another while a clip plays unreported. Regenerate to check the clips.',
      }] : []),
    ]
    : null;
  // An attachment whose anchor could not be measured was not checked, so it is
  // rendered as a note rather than left to the panel's clean label — "no
  // findings" and "never verified" must not read the same on screen.
  const unmeasuredAttachments = Array.isArray(record.physicalAudit?.unmeasuredAttachments)
    ? record.physicalAudit.unmeasuredAttachments
    : [];
  // Interior clip poses were first sampled with `poseCoverage`; an audit stored
  // before then measured an animated model only at clip and sequence
  // boundaries, which is reported as a gap rather than read as full coverage.
  const poseCoverage = Array.isArray(record.physicalAudit?.poseCoverage?.clips)
    ? record.physicalAudit.poseCoverage
    : null;
  const poseCoverageUnrecorded = !poseCoverage && listThreejsClips(record.spec).length > 0;
  const physicalAuditFindings = Array.isArray(record.physicalAudit?.findings)
    ? [
      ...record.physicalAudit.findings,
      ...unmeasuredAttachments.map((entry) => ({
        code: 'unmeasured-attachment',
        severity: 'note',
        message: `Attachment "${entry.partId}" could not be checked against ${entry.anchorSocket ? `socket "${entry.anchorSocket}"` : `"${entry.anchorPartId}"`} because ${entry.reason}.`,
      })),
      ...(poseCoverageUnrecorded ? [{
        code: 'clip-poses-unrecorded',
        severity: 'note',
        message: 'This audit predates interior clip-pose sampling: attachments were measured only at clip and sequence boundaries, so a part could leave its anchor mid-motion unreported. Regenerate to measure the clips mid-motion.',
      }] : []),
    ]
    : null;
  // Undecided contact is a note the reader is meant to judge, never something a
  // refinement is told to fix — so the footer only promises a refinement when
  // there is an actual defect above it.
  const penetrationDefects = countSeverities(penetrationFindings || []);
  const physicalAuditDefects = countSeverities(physicalAuditFindings || []);

  return (
    <>
    {penetrationFindings && (
      <GatePanel
        title="Cross-part penetration"
        findings={penetrationFindings}
        cleanLabel="No unrelated parts share the same space"
        onShowFinding={handleShowFinding}
        footer={`Parts modelled inside each other look correct from the hero angle and fall apart the moment the model is orbited, so this check compares every unrelated pair by volume. For a model with clips it also sweeps each clip through its sampled poses and reports a pair only when a pose makes it worse than at rest — a hatch swinging through its frame, a leg folding through the hull. Parts parented together, joined by an articulation joint or declared as attachments are exempt — embedding is what those relationships are for.${
          penetrationDefects.error + penetrationDefects.warning > 0
            ? ' Refining without your own feedback will also ask for each part to get its own volume and for no clip to drive one part through another.'
            : ''
        }`}
      >
        {penetrationPoseCoverage?.clips.length > 0 && <PoseCoverageList coverage={penetrationPoseCoverage} />}
      </GatePanel>
    )}

    {physicalAuditFindings && (
      <GatePanel
        title="Physical audit"
        findings={physicalAuditFindings}
        cleanLabel="Assembly satisfies physical attachment, exposure, and coplanarity rules"
        footer={`This check inspects the model across resting and animation poses to detect floating parts, swallowed geometry, z-fighting coplanar surfaces, unprovenanced appearing geometry, non-uniform parent scales that distort nested parts, and attachments that name nothing to hang from or sit further from their declared anchor than the spec allows.${
          physicalAuditDefects.error + physicalAuditDefects.warning > 0
            ? ' Refining without your own feedback will also target physical conformance defects.'
            : ''
        }`}
      >
        {poseCoverage?.clips.length > 0 && <PoseCoverageList coverage={poseCoverage} />}
      </GatePanel>
    )}
    </>
  );
}

export default function ModelReviewPanels({ record, coverageFamily, handleShowFinding }) {
  // A record generated before a gate shipped has no result at all, which is not
  // the same as passing it — the panel is omitted rather than shown clean.
  const coverageFindings = Array.isArray(record.coverage?.findings) ? record.coverage.findings : null;
  const flatnessFindings = Array.isArray(record.flatness?.findings) ? record.flatness.findings : null;
  const flatnessHasWarnings = flatnessFindings?.some((finding) => finding.severity === 'warning');
  const materialFindings = Array.isArray(record.materialPlausibility?.findings)
    ? record.materialPlausibility.findings
    : null;
  // A clean verdict only means something for a model that declared clips —
  // rendering "clips play cleanly" on every static model would be noise about a
  // feature it never used. A finding is worth showing either way: the gate also
  // reports an articulation graph that declares motion with no clip to play it,
  // which by definition arrives on a model with no clips.
  const animationFindings = Array.isArray(record.animation?.findings)
    && (record.animation.animated || record.animation.findings.length > 0)
    ? record.animation.findings
    : null;
  const coverageErrors = countSeverities(coverageFindings || []).error;

  return (
    <>
    {coverageFindings && (
      <GatePanel
        title="Assembly coverage"
        findings={coverageFindings}
        cleanLabel="Nothing promised was left unbuilt"
        footer={`${coverageFamily
          ? 'This check proves the model built what its own spec promised; the subject-family checklist below is what holds the spec itself to a floor.'
          : 'This check proves the model built what its own spec promised — never that the spec promised enough.'}${
          coverageErrors > 0 ? ' Refining without your own feedback will target the errors above.' : ''
        }`}
      />
    )}

    {coverageFamily && <FamilyChecklistPanel family={coverageFamily} />}

    {flatnessFindings && (
      <GatePanel
        title="Cross-section"
        findings={flatnessFindings}
        cleanLabel="Identity parts carry real depth"
        footer={`A model can match its reference head-on and still be a stack of cardboard cut-outs, so this check counts how many identity-defining features are built only from flat parts.${
          flatnessHasWarnings ? ' Refining without your own feedback will also ask for real depth.' : ''
        }`}
      />
    )}

      <CollisionAndPhysicalPanels record={record} handleShowFinding={handleShowFinding} />
    {materialFindings && (
      <GatePanel
        title="Material plausibility"
        findings={materialFindings}
        cleanLabel={record.materialPlausibility?.matchedMaterialCount > 0
          ? 'Recognized materials match their substance'
          : 'No material named a substance to check'}
        footer={`Every channel here is already inside what Three.js accepts, so this check asks the other question: whether the values suit the substance the material is named for — metallic wood and opaque glass both parse. Only materials whose id names exactly one substance are checked, and nothing is ever adjusted.${
          countSeverities(materialFindings).warning > 0
            ? ' Refining without your own feedback will also ask for values that match the substance — keep any deliberate stylization in your own feedback.'
            : ''
        }`}
      />
    )}

    {record.spec && (
      <RigReadinessPanel
        rig={record.rig && typeof record.rig === 'object' ? record.rig : null}
        spec={record.spec}
      />
    )}

    {record.spec && (
      <ClipInventoryPanel
        animation={record.animation && typeof record.animation === 'object' ? record.animation : null}
        spec={record.spec}
      />
    )}

    {animationFindings && (
      <GatePanel
        title="Clip playback"
        findings={animationFindings}
        cleanLabel="Clips open, hand over, and loop cleanly"
        footer={`The schema already proves a clip is well formed, so this check asks whether it will actually play: a clip authored against a pose the assembly does not build jumps the instant it opens, a handover between sequences that do not meet jumps mid-clip, and a loop that ends somewhere else snaps on every repeat.${
          animationFindings.length > 0
            ? ' Refining without your own feedback will also ask for clips that start from the assembled pose and close their loops.'
            : ''
        }`}
      />
    )}

    {record.spec?.detailInventory?.length > 0 && (
      <section className="rounded-xl border border-port-border bg-port-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">Detail inventory</h2>
          <span className="text-xs text-gray-600">{record.spec.detailInventory.length} modeled features</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {record.spec.detailInventory.map((detail, index) => (
            <div key={`${detail.feature}-${index}`} className="rounded-lg border border-port-border bg-port-bg/50 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-xs font-medium text-gray-200">{detail.feature}</h3>
                <span className="rounded bg-port-border px-1.5 py-0.5 text-[9px] uppercase text-gray-400">{detail.priority}</span>
              </div>
              <p className="mt-1 text-xs text-gray-500">{detail.evidence}</p>
              <p className="mt-1 text-[10px] text-port-accent">{detail.implementationPartIds.join(' · ')}</p>
            </div>
          ))}
        </div>
      </section>
    )}
    </>
  );
}
