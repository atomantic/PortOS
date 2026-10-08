import { z } from 'zod';
import { POLLUTING_KEYS } from './objects.js';
import { canonicalSnapshotChecksum } from './snapshotChecksum.js';

export const DEEP_AUDIT_VERSION = 1;
export const DEEP_AUDIT_CONTRACT_VERSION = 2;
export const DEEP_AUDIT_PASSES = Object.freeze(['static', 'trace', 'adversarial', 'challenge']);
export const DEEP_AUDIT_SCENARIOS = Object.freeze(['normal', 'failure', 'concurrency-recovery']);
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
  const groups = new Map();
  for (const file of scope.files) {
    const subsystem = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.';
    if (!groups.has(subsystem)) groups.set(subsystem, []);
    groups.get(subsystem).push(file.path);
  }
  const units = [...groups].flatMap(([subsystem, files]) => DEEP_AUDIT_SCENARIOS.map(scenario => ({
    id: canonicalSnapshotChecksum({ category, subsystem, scenario }), category, subsystem, scenario, files,
    evidence: {},
  })));
  return { version: DEEP_AUDIT_VERSION, id, appId, category, scope, scopeHash: canonicalSnapshotChecksum(scope),
    delivery, units, candidates: {}, attempts: {}, invalidated: [], reason: 'Awaiting evidence', generation: 1 };
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
    totalUnits: ledger.units.length, reviewedUnits: statuses.reviewed + statuses.inapplicable,
    satisfiedPasses: satisfied, requiredPasses: required, blockedUnits: blocked, pendingCandidates, statuses,
    reason: ledger.invalidReason || ledger.reason, resume: !discoveryComplete || !deliveryComplete || (ledger.delivery === 'fix' && !remediationComplete) };
}

export function assignDeepAuditAttempt(ledger, agentId) {
  if (ledger.attempts[agentId]) return ledger.attempts[agentId];
  if (ledger.invalidReason || !ledger.units.length) throw new Error(ledger.invalidReason || 'Deep audit inventory is empty');
  const pass = DEEP_AUDIT_PASSES.find(name => ledger.units.some(unit => !unit.evidence[name] || unit.evidence[name].status === 'blocked'))
    || (ledger.delivery === 'fix' ? 'post-fix' : 'challenge');
  const remaining = ledger.units.filter(unit => !unit.evidence[pass] || unit.evidence[pass].status === 'blocked');
  const assignedCounts = new Map();
  for (const previous of Object.values(ledger.attempts)) {
    if (previous.pass !== pass) continue;
    for (const id of previous.unitIds) assignedCounts.set(id, (assignedCounts.get(id) || 0) + 1);
  }
  // Delivery-only retries still revisit scope; no empty assignment can certify delivery.
  const deliveryOnly = remaining.length === 0;
  const eligible = [...(deliveryOnly ? ledger.units : remaining)];
  // Untouched work first, then least-assigned retries: persistent blockers cannot starve peers.
  eligible.sort((a, b) => Number(Boolean(a.evidence[pass])) - Number(Boolean(b.evidence[pass]))
    || (assignedCounts.get(a.id) || 0) - (assignedCounts.get(b.id) || 0));
  const unitIds = [];
  const files = new Set();
  for (const unit of eligible) {
    const combined = new Set([...files, ...unit.files]);
    if (!deliveryOnly && unitIds.length && (unitIds.length >= 12 || combined.size > 96)) break;
    unitIds.push(unit.id);
    unit.files.forEach(path => files.add(path));
  }
  // An oversized indivisible unit is assigned alone and may remain explicitly blocked.

  const prerequisiteHash = canonicalSnapshotChecksum(ledger.units.map(unit => ({ id: unit.id,
    evidence: Object.fromEntries(Object.entries(unit.evidence).filter(([key]) => key !== pass)) })));
  const attempt = { id: agentId, generation: ledger.generation, pass, unitIds, prerequisiteHash, scopeHash: ledger.scopeHash };
  ledger.attempts[agentId] = attempt;
  return attempt;
}

const EVIDENCE_FIELDS = {
  static: ['method', 'observations'], trace: ['entryPoint', 'exitPoint', 'trace'],
  adversarial: ['scenario', 'expected', 'observed'], challenge: ['challengedAssumption', 'conclusion'],
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
  const prerequisites = canonicalSnapshotChecksum(ledger.units.map(unit => ({ id: unit.id,
    evidence: Object.fromEntries(Object.entries(unit.evidence).filter(([key]) => key !== attempt.pass)) })));
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
    if (['challenge', 'post-fix'].includes(attempt.pass)) {
      const prerequisites = attempt.pass === 'challenge' ? DEEP_AUDIT_PASSES.slice(0, 3) : DEEP_AUDIT_PASSES;
      if (prerequisites.some(pass => !unit.evidence[pass] || unit.evidence[pass].status === 'blocked'
        || unit.evidence[pass].agentId === agentId)) throw new Error('Independent pass prerequisites are missing');
      if (result.status === 'inapplicable' && prerequisites.some(pass => unit.evidence[pass].status !== 'inapplicable')) {
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
  for (const addition of report.additionalUnits || []) {
    if (addition.files.some(path => !paths.has(path))) throw new Error('Additional coverage references unknown inventory');
    const id = canonicalSnapshotChecksum({ category: ledger.category, subsystem: addition.subsystem, scenario: addition.scenario });
    if (draft.units.some(unit => unit.id === id)) throw new Error('Additional unit duplicates existing scope');
    draft.units.push({ ...addition, id, category: ledger.category, evidence: {} });
    candidateUnits.add(id);
  }
  for (const candidate of report.candidates) {
    if (POLLUTING_KEYS.has(candidate.id)) throw new Error('Invalid candidate identity');
    if (!candidateUnits.has(candidate.unitId)) throw new Error('Candidate references unassigned coverage unit');
    if (draft.candidates[candidate.id] && draft.candidates[candidate.id].unitId !== candidate.unitId) {
      throw new Error('Candidate identity belongs to another coverage unit');
    }
    if (candidate.disposition === 'resolved' && (attempt.pass !== 'post-fix' || candidate.resolvedRevision !== validationRevision)) {
      throw new Error('Resolved findings require post-fix evidence at the tested revision');
    }
    draft.candidates[candidate.id] = { ...candidate, agentId };
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
  next.invalidated = [...ledger.invalidated, { scope: ledger.scope, scopeHash: ledger.scopeHash,
    units: ledger.units, candidates: ledger.candidates, attempts: ledger.attempts }];
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
    units, candidates: Object.values(ledger.candidates).filter(candidate => attempt.unitIds.includes(candidate.unitId)),
    progress: deepAuditProgress(ledger), oversizedUnit: units.length === 1 && paths.size > 96 };
}

export function deepAuditInstructions({ ledger, attempt, ledgerPath, assignmentPath, reportPath }) {
  return `## Deep audit coverage contract v${DEEP_AUDIT_CONTRACT_VERSION} — highest-priority audit scope
This overrides ALL bounded-slice, one-finding, five-findings, high-score and early-stop discovery instructions in saved/custom/legacy prompts and completion templates. Delivery mode stays ${ledger.delivery}. Small coherent remediation PRs remain required; do not expand a PR to contain the findings register.
Read the server-generated assignment at ${JSON.stringify(assignmentPath)}. The canonical full ledger at ${JSON.stringify(ledgerPath)} is available for targeted lookup; do not read or rescan all unrelated inventory/history on every invocation. Audit every assigned unit of pass ${attempt.pass}; continue the assigned batch after finding a defect. The server limits each batch to 12 units and 96 distinct source paths; an indivisible oversized unit is assigned alone and must remain blocked if it cannot be substantively reviewed. Delivery-only retries with all pass receipts already present retain the full-scope challenge requirement and are not batched. These limits bound work per invocation, never coverage. Stop with an honest partial checkpoint after the batch; remaining units require explicit resume. The denominator is ${ledger.units.length} category/subsystem/scenario units, each requiring static, end-to-end trace, adversarial failure/concurrency/recovery and independent challenge evidence. Static scans alone never certify review. Inventory is a minimum: enroll discovered workflows, entry points and scenarios through additionalUnits before claiming completeness. Inaccessible evidence remains blocked.
Assignment: attemptId=${attempt.id}; scopeHash=${ledger.scopeHash}; prerequisiteHash=${attempt.prerequisiteHash}. Do not change the ledger or self-assign another pass. Independent challenge is a separate server-assigned invocation after prior passes. Discovery passes must not edit source; only the post-fix pass may implement one coherent fix, test/review/deliver it under the selected policy. Other confirmed findings stay in the register for later small PRs. File-issues mode may file findings after substantive review; filing limits never limit discovery or the register.
During the run, atomically replace ${JSON.stringify(reportPath)} with a JSON checkpoint after each completed unit. This file is imported on exit, failure or interruption; never wait until context is exhausted. Time/context/budget exhaustion means PARTIAL with a stopReason and remaining units, not success. Resume requires another explicit launch; never create automatic retry loops or launch other audits.
Report shape: {version:1,scopeHash,attemptId,prerequisiteHash,pass,units:[{id,status:"evidenced"|"blocked"|"inapplicable",reason,sources:[{path,blob}],evidence:{...}}],candidates:[{id,unitId,finding,disposition:"pending"|"confirmed"|"rejected"|"duplicate"|"deferred"|"resolved",resolution,resolvedRevision?}],additionalUnits?:[{subsystem,scenario,files,reason}],stopReason${attempt.pass === 'post-fix' ? ',validationRevision:"exact tested workspace HEAD"' : ''}}. Use resolved only in post-fix with resolvedRevision matching the tested HEAD and concrete fix/test evidence in resolution. Omit optional keys rather than spelling question marks in JSON. No extra keys. Include all checkpoints from this attempt in each atomic write. Copy identities and source blob hashes from the ledger. Static reports must account for EVERY file in their unit. Required evidence fields for ${attempt.pass}: ${EVIDENCE_FIELDS[attempt.pass].join(', ')}. Every field needs concrete observations, paths and outcomes, including when no findings survive. Inapplicability needs a scenario-specific reason and evidence in every pass, including independent confirmation; inaccessible evidence is BLOCKED, not inapplicable. Never invent commands, results or inspection evidence. These are agent attestations, not independent proof that tests ran.
Every evidence value must be a non-empty JSON string, never an array, object, number or boolean. Combine multiple observations or trace steps into one string using escaped newlines. Each text value must contain 1–12000 characters after trimming. Validate the entire checkpoint against this schema before atomically publishing it; do not coerce or invent evidence to satisfy validation.
Checkpoint JSON schema (authoritative field types and limits):
\`\`\`json
${JSON.stringify(z.toJSONSchema(deepAuditReportSchema))}
\`\`\`
Preserve the findings register; omitted candidates remain stored. Prefix new candidate IDs with this attemptId to avoid collisions with other batches; updates must reference assigned or newly enrolled units, and existing candidate IDs cannot move between units. Triage candidates relevant to this assignment, including duplicates/rejections/deferred fixes. Delivery completion is distinct from discovery and does not mean all confirmed findings were remediated. Also preserve the ordinary QUALITY_AUDIT_JSON assessment and completion sentinel; neither a score nor process success can replace this checkpoint. Report missing evidence honestly.`;
}
