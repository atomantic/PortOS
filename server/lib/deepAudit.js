import { z } from 'zod';
import { POLLUTING_KEYS } from './objects.js';
import { canonicalSnapshotChecksum } from './snapshotChecksum.js';
import { createDeepAuditCoverage, partitionDeepAuditGroup, isDeepAuditContractUpgrade } from './deepAuditCoverage.js';
export { DEEP_AUDIT_SCENARIOS } from './deepAuditCoverage.js';

export const DEEP_AUDIT_VERSION = 1;
export const DEEP_AUDIT_CONTRACT_VERSION = 3;
export const DEEP_AUDIT_PASSES = Object.freeze(['static', 'trace', 'adversarial', 'challenge']);
const text = z.string().trim().min(1).max(12000);
const source = z.object({ path: text, blob: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict();
export const deepAuditReportSchema = z.object({
  version: z.literal(DEEP_AUDIT_VERSION),
  scopeHash: text,
  attemptId: text,
  prerequisiteHash: text,
  pass: z.enum([...DEEP_AUDIT_PASSES, 'post-fix']),
  units: z.array(z.object({
    id: text,
    status: z.enum(['evidenced', 'blocked', 'inapplicable']),
    reason: text,
    sources: z.array(source).min(1),
    evidence: z.record(z.string(), text),
  }).strict()).max(50000),
  candidates: z.array(z.object({
    id: text, unitId: text, finding: text,
    disposition: z.enum(['pending', 'confirmed', 'rejected', 'duplicate', 'deferred', 'resolved']),
    resolvedRevision: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
    resolution: text,
  }).strict()).max(50000),
  additionalUnits: z.array(z.object({ subsystem: text, scenario: text, files: z.array(text).min(1), reason: text }).strict()).max(1000).optional(),
  stopReason: text,
  validationRevision: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
}).strict();

/** Every tracked path belongs to a subsystem; unknown file types are not dropped. */
export function createDeepAuditLedger({ id, appId, category, scope, delivery }) {
  const { groups, units } = createDeepAuditCoverage(category, scope.files);
  return { version: DEEP_AUDIT_VERSION, id, appId, category, scope, scopeHash: canonicalSnapshotChecksum(scope),
    delivery, coverageVersion: DEEP_AUDIT_CONTRACT_VERSION, groups, units, candidates: {}, attempts: {}, invalidated: [], reason: 'Awaiting evidence', generation: 1 };
}

export function deepAuditProgress(ledger) {
  let satisfied = 0;
  let blocked = 0;
  const statuses = { pending: 0, scanned: 0, traced: 0, validated: 0, reviewed: 0, blocked: 0, inapplicable: 0 };
  for (const unit of ledger.units) {
    const receipts = DEEP_AUDIT_PASSES.map(pass => unit.evidence[pass]);
    const hasBlocker = receipts.some(receipt => receipt?.status === 'blocked');
    const count = receipts.filter(receipt => receipt && receipt.status !== 'blocked').length;
    satisfied += count;
    if (hasBlocker) blocked++;
    const status = hasBlocker ? 'blocked' : count === 4 && receipts.every(receipt => receipt.status === 'inapplicable')
      ? 'inapplicable' : ['pending', 'scanned', 'traced', 'validated', 'reviewed'][count];
    statuses[status]++;
  }
  const unitsById = new Map(ledger.units.map(unit => [unit.id, unit]));
  const reviewedGroupIds = new Set((ledger.groups || []).filter(group => group.unitIds.every(id => {
    const unit = unitsById.get(id);
    return unit && DEEP_AUDIT_PASSES.every(pass => validReceipt(unit.evidence[pass]));
  })).map(group => group.id));
  const pendingCandidates = Object.values(ledger.candidates).filter(candidate => candidate.disposition === 'pending').length;
  const required = ledger.units.length * DEEP_AUDIT_PASSES.length;
  const discoveryComplete = required > 0 && !ledger.scope.files.some(file => file.kind === 'commit') && !ledger.invalidReason && satisfied === required && !blocked && !pendingCandidates;
  const postFixComplete = Boolean(ledger.validationRevision) && ledger.units.length > 0 && ledger.units.every(unit => unit.evidence['post-fix']?.status === 'evidenced'
    && unit.evidence['post-fix'].validationRevision === ledger.validationRevision);
  const deliveryComplete = ledger.delivery === 'file-issues' ? ledger.deliveryVerified === true
    : postFixComplete && ledger.deliveryVerified === true;
  const pendingRemediations = Object.values(ledger.candidates).filter(candidate => ['pending', 'confirmed', 'deferred'].includes(candidate.disposition)
    || (candidate.disposition === 'resolved' && candidate.resolvedRevision !== ledger.validationRevision)).length;
  const remediationComplete = ledger.delivery === 'fix' && deliveryComplete && pendingRemediations === 0;
  return { discoveryComplete, remediationComplete,
    deliveryComplete, pendingRemediations, complete: discoveryComplete && deliveryComplete && (ledger.delivery !== 'fix' || remediationComplete),
    totalGroups: ledger.groups?.length ?? ledger.units.length, reviewedGroups: reviewedGroupIds.size,
    totalUnits: ledger.units.length, reviewedUnits: statuses.reviewed + statuses.inapplicable,
    satisfiedPasses: satisfied, requiredPasses: required, blockedUnits: blocked, pendingCandidates, statuses,
    reason: ledger.invalidReason || ledger.reason, resume: !discoveryComplete || !deliveryComplete || (ledger.delivery === 'fix' && !remediationComplete) };
}

const priorPasses = pass => pass === 'post-fix' ? DEEP_AUDIT_PASSES : DEEP_AUDIT_PASSES.slice(0, DEEP_AUDIT_PASSES.indexOf(pass));
const validReceipt = receipt => receipt && receipt.status !== 'blocked';
function prerequisiteHash(ledger, pass, unitIds) {
  return canonicalSnapshotChecksum({ validationRevision: pass === 'post-fix' ? ledger.validationRevision ?? null : null,
    units: ledger.units.filter(unit => unitIds.includes(unit.id)).map(unit => ({ id: unit.id,
      evidence: Object.fromEntries(Object.entries(unit.evidence).filter(([name]) => name !== pass)) })) });
}

export function assignDeepAuditAttempt(ledger, agentId) {
  if (ledger.attempts[agentId]) return ledger.attempts[agentId];
  if (ledger.invalidReason || !ledger.units.length) throw new Error(ledger.invalidReason || 'Deep audit inventory is empty');
  const counts = new Map();
  for (const attempt of Object.values(ledger.attempts)) {
    for (const id of attempt.unitIds) {
      const key = `${attempt.pass}:${id}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  // Each partition advances independently; a blocked neighbor cannot starve its trace.
  let eligible = ledger.units.flatMap(unit => {
    const pass = DEEP_AUDIT_PASSES.find(name => !validReceipt(unit.evidence[name]));
    return pass ? [{ unit, pass }] : [];
  });
  let deliveryOnly = false;
  if (!eligible.length) {
    const pass = ledger.delivery === 'fix' ? 'post-fix' : 'challenge';
    eligible = ledger.units.filter(unit => !validReceipt(unit.evidence[pass])
      || (pass === 'post-fix' && unit.evidence[pass]?.validationRevision !== ledger.validationRevision)).map(unit => ({ unit, pass }));
    deliveryOnly = eligible.length === 0;
    if (deliveryOnly) eligible = ledger.units.map(unit => ({ unit, pass }));
  }
  const passes = [...DEEP_AUDIT_PASSES, 'post-fix'];
  const last = Object.values(ledger.attempts).at(-1)?.pass;
  const next = (passes.indexOf(last) + 1) % passes.length;
  const rank = item => [Number(Boolean(item.unit.evidence[item.pass])), counts.get(`${item.pass}:${item.unit.id}`) || 0,
    (passes.indexOf(item.pass) - next + passes.length) % passes.length];
  const compare = (a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.unit.files[0].localeCompare(b.unit.files[0]) || a.unit.id.localeCompare(b.unit.id); };
  eligible.sort(compare);
  const pass = eligible[0].pass;
  const unitIds = [], files = new Set();
  for (const { unit } of eligible.filter(item => item.pass === pass)) {
    const combined = new Set([...files, ...unit.files]);
    if (unitIds.length && (unitIds.length >= 12 || combined.size > 96)) continue;
    unitIds.push(unit.id); unit.files.forEach(path => files.add(path));
  }
  const attempt = { id: agentId, generation: ledger.generation, pass, unitIds, deliveryOnly,
    prerequisiteHash: prerequisiteHash(ledger, pass, unitIds), scopeHash: ledger.scopeHash };
  ledger.attempts[agentId] = attempt;
  return attempt;
}

const EVIDENCE_FIELDS = {
  static: ['method', 'observations'], trace: ['entryPoint', 'exitPoint', 'trace', 'inbound', 'outbound', 'boundaryObservations', 'unresolvedBoundaries'],
  adversarial: ['scenario', 'expected', 'observed', 'boundaryFailures'], challenge: ['challengedAssumption', 'conclusion', 'boundaryChallenge'],
  'post-fix': ['command', 'result', 'review', 'delivery'],
};

/** Agent text never chooses scope, assignment, identity, or a completion flag. */
export function mergeDeepAuditReport(ledger, agentId, raw, { deliverySuccess = false, validationRevision = null } = {}) {
  const report = deepAuditReportSchema.parse(raw);
  const attempt = ledger.attempts[agentId];
  if (!attempt || attempt.generation !== ledger.generation || report.scopeHash !== ledger.scopeHash
    || report.attemptId !== agentId || report.pass !== attempt.pass || report.prerequisiteHash !== attempt.prerequisiteHash) {
    throw new Error('Deep audit report does not match the assigned scope and pass');
  }
  const digest = canonicalSnapshotChecksum(report);
  if (attempt.reportHash === digest) return ledger;
  if (attempt.reportHash) throw new Error('Deep audit attempt already checkpointed; resume with a new agent');
  const prerequisites = prerequisiteHash(ledger, attempt.pass, attempt.unitIds);
  if (prerequisites !== attempt.prerequisiteHash) throw new Error('Deep audit prerequisite evidence changed; resume with a fresh assignment');
  const draft = structuredClone(ledger);
  const paths = new Map(ledger.scope.files.map(file => [file.path, file.blob]));
  if (attempt.pass === 'post-fix') {
    if (draft.validationRevision !== validationRevision) {
      for (const unit of draft.units) delete unit.evidence['post-fix'];
      draft.deliveryVerified = false;
    }
    draft.validationRevision = validationRevision;
  }
  const seen = new Set();
  for (const result of report.units) {
    const unit = draft.units.find(entry => entry.id === result.id);
    if (!unit || !attempt.unitIds.includes(unit.id) || seen.has(unit.id)) throw new Error('Unknown, unassigned or repeated Deep audit unit');
    seen.add(unit.id);
    if (result.status !== 'blocked' && ledger.scope.files.some(file => file.kind === 'commit' && unit.files.includes(file.path))) {
      throw new Error('Unexpanded submodule requires a blocked unit, not a coverage claim');
    }
    if (result.sources.some(ref => paths.get(ref.path) !== ref.blob)) throw new Error('Deep audit source evidence does not match pinned inventory');
    if (!result.sources.some(ref => unit.files.includes(ref.path))) throw new Error('Deep audit evidence must reference its own unit');
    if (attempt.pass === 'static' && unit.files.some(path => !result.sources.some(ref => ref.path === path))) {
      throw new Error('Static evidence must account for every inventory member');
    }
    if (result.status !== 'blocked' && EVIDENCE_FIELDS[attempt.pass].some(field => !result.evidence[field])) {
      throw new Error(`Missing ${attempt.pass} evidence`);
    }
    if (attempt.pass !== 'static') {
      const prerequisites = priorPasses(attempt.pass);
      if (prerequisites.some(pass => !unit.evidence[pass] || unit.evidence[pass].status === 'blocked'
        || (['challenge', 'post-fix'].includes(attempt.pass) && unit.evidence[pass].agentId === agentId))) throw new Error('Independent pass prerequisites are missing');
      if (attempt.pass === 'challenge' && result.status === 'inapplicable' && prerequisites.some(pass => unit.evidence[pass].status !== 'inapplicable')) {
        throw new Error('Independent review must confirm prior inapplicability reasons');
      }
    }
    if (attempt.pass === 'post-fix' && (!validationRevision || report.validationRevision !== validationRevision)) {
      throw new Error('Post-fix evidence must bind to the verified workspace revision');
    }
    unit.evidence[attempt.pass] = { ...result, agentId, prerequisiteHash: attempt.prerequisiteHash,
      ...(attempt.pass === 'post-fix' ? { validationRevision } : {}), attestation: 'agent-reported, source-verified' };
  }
  const candidateUnits = new Set(attempt.unitIds);
  const assignedGroups = new Set(draft.units.filter(unit => candidateUnits.has(unit.id)).map(unit => unit.groupId));
  for (const addition of report.additionalUnits || []) {
    if (addition.files.some(path => !paths.has(path))) throw new Error('Additional coverage references unknown inventory');
    const partitioned = partitionDeepAuditGroup({ ...addition, category: ledger.category });
    if (draft.groups.some(group => group.id === partitioned.group.id)) throw new Error('Additional unit duplicates existing scope');
    draft.groups.push(partitioned.group); draft.units.push(...partitioned.units);
    partitioned.units.forEach(unit => candidateUnits.add(unit.id));
  }
  for (const candidate of report.candidates) {
    if (POLLUTING_KEYS.has(candidate.id)) throw new Error('Invalid candidate identity');
    const previous = draft.candidates[candidate.id];
    const legacyGroup = previous?.groupScoped === true && previous.unitId === candidate.unitId && assignedGroups.has(candidate.unitId);
    if (!candidateUnits.has(candidate.unitId) && !legacyGroup) throw new Error('Candidate references unassigned coverage unit');
    if (draft.candidates[candidate.id] && draft.candidates[candidate.id].unitId !== candidate.unitId) {
      throw new Error('Candidate identity belongs to another coverage unit');
    }
    if (candidate.disposition === 'resolved' && (attempt.pass !== 'post-fix' || candidate.resolvedRevision !== validationRevision)) {
      throw new Error('Resolved findings require post-fix evidence at the tested revision');
    }
    draft.candidates[candidate.id] = { ...candidate, agentId, ...(legacyGroup ? { groupScoped: true } : {}) };
  }
  draft.attempts[agentId].reportHash = digest;
  draft.reason = report.stopReason;
  draft.lastReportAgent = agentId;
  draft.deliveryVerified = deliverySuccess;
  return draft;
}

export function refreshDeepAuditScope(ledger, scope) {
  const scopeHash = canonicalSnapshotChecksum(scope);
  if (scopeHash === ledger.scopeHash && !ledger.invalidReason) return ledger;
  const next = createDeepAuditLedger({ ...ledger, scope });
  next.generation = ledger.generation + 1;
  const historical = { ...ledger };
  delete historical.invalidated;
  next.invalidated = [...ledger.invalidated, historical];
  if (isDeepAuditContractUpgrade(ledger.scope, scope)) {
    // Preserve enrolled workflows and findings, but never manufacture new coverage.
    for (const old of ledger.groups || ledger.units) {
      if (next.groups.some(group => group.id === old.id)) continue;
      const partitioned = partitionDeepAuditGroup({ ...old, category: ledger.category });
      next.groups.push(partitioned.group); next.units.push(...partitioned.units);
    }
    const priorUnits = new Map(ledger.units.map(unit => [unit.id, unit]));
    next.candidates = Object.fromEntries(Object.entries(ledger.candidates).map(([id, candidate]) => [id,
      { ...candidate, unitId: priorUnits.get(candidate.unitId)?.groupId || candidate.unitId, groupScoped: true }]));
    next.coverageMigration = { fromContract: ledger.scope.promptVersions?.contract, toContract: scope.promptVersions?.contract,
      priorRequiredPasses: ledger.units.length * 4, requiredPasses: next.units.length * 4,
      reason: 'Previous receipts are historical; partition and cross-boundary obligations require fresh evidence. Findings retained at original group scope.' };
  }
  next.reason = 'Source, inventory, capabilities or prompt changed; previous evidence retained as stale';
  return next;
}

/** Agent-facing projection; the canonical ledger remains the authority for every receipt. */
export function deepAuditAssignment(ledger, attempt) {
  const byId = new Map(ledger.units.map(unit => [unit.id, unit]));
  const units = attempt.unitIds.map(id => byId.get(id));
  const paths = new Set(units.flatMap(unit => unit.files));
  return { version: ledger.version, id: ledger.id, category: ledger.category, delivery: ledger.delivery,
    scopeHash: ledger.scopeHash, generation: ledger.generation, attempt,
    scope: { ...ledger.scope, files: ledger.scope.files.filter(file => paths.has(file.path)) },
    units, groups: ledger.groups?.filter(group => units.some(unit => unit.groupId === group.id)).map(({ files, ...group }) => ({ ...group, totalFiles: files.length })),
    candidates: Object.values(ledger.candidates).filter(candidate => attempt.unitIds.includes(candidate.unitId)
      || (candidate.groupScoped && units.some(unit => unit.groupId === candidate.unitId))),
    progress: deepAuditProgress(ledger), coverageMigration: ledger.coverageMigration };
}

export function deepAuditInstructions({ ledger, attempt, ledgerPath, assignmentPath, reportPath }) {
  return `## Deep audit coverage contract v${DEEP_AUDIT_CONTRACT_VERSION} — highest-priority audit scope
This overrides ALL bounded-slice, one-finding, five-findings, high-score and early-stop discovery instructions in saved/custom/legacy prompts and completion templates. Delivery mode stays ${ledger.delivery}. Small coherent remediation PRs remain required; do not expand a PR to contain the findings register.
Read the server-generated assignment at ${JSON.stringify(assignmentPath)}. The canonical full ledger at ${JSON.stringify(ledgerPath)} is available for targeted lookup; do not read or rescan all unrelated inventory/history on every invocation. Audit every assigned unit of pass ${attempt.pass}; continue the assigned batch after finding a defect. The server limits each batch to 12 units and 96 distinct source paths; each deterministic partition owns at most 24 files for one subsystem/scenario. A single large file or genuinely unavailable runtime evidence may still require an honest blocker. Delivery-only retries are explicitly marked on the assignment: prior full coverage remains required, with bounded re-attestation and actual publication verification; they are not new full-scope reviews. These limits bound work per invocation, never coverage. Stop with an honest partial checkpoint after the batch; remaining units require explicit resume. The denominator is ${ledger.units.length} category/subsystem/scenario partitions, each requiring static, end-to-end trace, adversarial failure/concurrency/recovery and independent challenge evidence. Static scans alone never certify review. Inventory is a minimum: enroll discovered workflows, entry points and scenarios through additionalUnits before claiming completeness. Inaccessible required evidence remains blocked. A verified defect is reviewed evidence, not automatically a blocker: inspect a dangling tracked symlink blob and prove its target absent rather than claiming to review nonexistent target contents.
Assignment: attemptId=${attempt.id}; scopeHash=${ledger.scopeHash}; prerequisiteHash=${attempt.prerequisiteHash}. Do not change the ledger or self-assign another pass. Each partition advances only after its own prerequisite passes; independent challenge is a separate server-assigned invocation. Trace must name concrete inbound caller paths, outbound dependency paths, boundary behavior and unresolved questions; adversarial evidence must test boundary failures, and challenge must independently examine these cross-file assumptions. Follow relevant callers/callees outside the partition and cite their pinned identities as context; context references never credit their owned coverage. Groups complete only when every partition meets every pass. New workflows require additionalUnits; do not hide cross-boundary work behind partition limits. Discovery passes must not edit source; only the post-fix pass may implement one coherent fix, test/review/deliver it under the selected policy. Other confirmed findings stay in the register for later small PRs. File-issues mode may file findings after substantive review; filing limits never limit discovery or the register.
During the run, atomically replace ${JSON.stringify(reportPath)} with a JSON checkpoint after each completed unit. This file is imported on exit, failure or interruption; never wait until context is exhausted. Time/context/budget exhaustion means PARTIAL with a stopReason and remaining units, not success. Resume requires another explicit launch; never create automatic retry loops or launch other audits.
Report shape: {version:1,scopeHash,attemptId,prerequisiteHash,pass,units:[{id,status:"evidenced"|"blocked"|"inapplicable",reason,sources:[{path,blob}],evidence:{...}}],candidates:[{id,unitId,finding,disposition:"pending"|"confirmed"|"rejected"|"duplicate"|"deferred"|"resolved",resolution,resolvedRevision?}],additionalUnits?:[{subsystem,scenario,files,reason}],stopReason${attempt.pass === 'post-fix' ? ',validationRevision:"exact tested workspace HEAD"' : ''}}. Use resolved only in post-fix with resolvedRevision matching the tested HEAD and concrete fix/test evidence in resolution. Omit optional keys rather than spelling question marks in JSON. No extra keys. Include all checkpoints from this attempt in each atomic write. Copy identities and source blob hashes from the ledger. Static reports must account for EVERY file in their unit. Required evidence fields for ${attempt.pass}: ${EVIDENCE_FIELDS[attempt.pass].join(', ')}. Every field needs concrete observations, paths and outcomes, including when no findings survive. Inapplicability needs a scenario-specific reason and evidence in every pass, including independent confirmation; inaccessible evidence is BLOCKED, not inapplicable. Never invent commands, results or inspection evidence. These are agent attestations, not independent proof that tests ran.
Every evidence value must be a non-empty JSON string, never an array, object, number or boolean. Combine multiple observations or trace steps into one string using escaped newlines. Each text value must contain 1–12000 characters after trimming. Validate the entire checkpoint against this schema before atomically publishing it; do not coerce or invent evidence to satisfy validation.
Checkpoint JSON schema (authoritative field types and limits):
\`\`\`json
${JSON.stringify(z.toJSONSchema(deepAuditReportSchema))}
\`\`\`
Preserve the findings register; omitted candidates remain stored. Prefix new candidate IDs with this attemptId to avoid collisions with other batches; updates must reference assigned or newly enrolled partitions. Legacy groupScoped findings are visible in every assigned partition of their original group; they remain group-scoped and their identity/group cannot move. New findings must name an assigned partition; relate newly discovered workflows to their originating assigned partition until the server assigns their additional partitions. Group visibility never grants coverage credit. Triage candidates relevant to this assignment, including duplicates/rejections/deferred fixes. Delivery completion is distinct from discovery and does not mean all confirmed findings were remediated. Also preserve the ordinary QUALITY_AUDIT_JSON assessment and completion sentinel; neither a score nor process success can replace this checkpoint. Report missing evidence honestly.`;
}
