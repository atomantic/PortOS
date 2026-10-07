import { z } from 'zod';
import { POLLUTING_KEYS } from './objects.js';
import { canonicalSnapshotChecksum } from './snapshotChecksum.js';

export const DEEP_AUDIT_VERSION = 1;
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
  const units = ledger.units.filter(unit => !unit.evidence[pass] || unit.evidence[pass].status === 'blocked').map(unit => unit.id);
  // A delivery-only retry still challenges the entire scope rather than accepting an empty proof.
  const unitIds = units.length ? units : ledger.units.map(unit => unit.id);
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
  for (const addition of report.additionalUnits || []) {
    if (addition.files.some(path => !paths.has(path))) throw new Error('Additional coverage references unknown inventory');
    const id = canonicalSnapshotChecksum({ category: ledger.category, subsystem: addition.subsystem, scenario: addition.scenario });
    if (draft.units.some(unit => unit.id === id)) throw new Error('Additional unit duplicates existing scope');
    draft.units.push({ ...addition, id, category: ledger.category, evidence: {} });
  }
  for (const candidate of report.candidates) {
    if (POLLUTING_KEYS.has(candidate.id)) throw new Error('Invalid candidate identity');
    if (!draft.units.some(unit => unit.id === candidate.unitId)) throw new Error('Candidate references unknown coverage unit');
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

export function deepAuditInstructions({ ledger, attempt, ledgerPath, reportPath }) {
  return `## Deep audit coverage contract v${DEEP_AUDIT_VERSION} — highest-priority audit scope
This overrides ALL bounded-slice, one-finding, five-findings, high-score and early-stop discovery instructions in saved/custom/legacy prompts and completion templates. Delivery mode stays ${ledger.delivery}. Small coherent remediation PRs remain required; do not expand a PR to contain the findings register.
Read the entire server-generated ledger at ${JSON.stringify(ledgerPath)}. Audit every assigned unit of pass ${attempt.pass}; follow all remaining units after finding a defect. The denominator is ${ledger.units.length} category/subsystem/scenario units, each requiring static, end-to-end trace, adversarial failure/concurrency/recovery and independent challenge evidence. Static scans alone never certify review. Inventory is a minimum: enroll discovered workflows, entry points and scenarios through additionalUnits before claiming completeness. Inaccessible evidence remains blocked.
Assignment: attemptId=${attempt.id}; scopeHash=${ledger.scopeHash}; prerequisiteHash=${attempt.prerequisiteHash}. Do not change the ledger or self-assign another pass. Independent challenge is a separate server-assigned invocation after prior passes. Discovery passes must not edit source; only the post-fix pass may implement one coherent fix, test/review/deliver it under the selected policy. Other confirmed findings stay in the register for later small PRs. File-issues mode may file findings after substantive review; filing limits never limit discovery or the register.
During the run, atomically replace ${JSON.stringify(reportPath)} with a JSON checkpoint after each completed unit. This file is imported on exit, failure or interruption; never wait until context is exhausted. Time/context/budget exhaustion means PARTIAL with a stopReason and remaining units, not success. Resume requires another explicit launch; never create automatic retry loops or launch other audits.
Report shape: {version:1,scopeHash,attemptId,prerequisiteHash,pass,units:[{id,status:"evidenced"|"blocked"|"inapplicable",reason,sources:[{path,blob}],evidence:{...}}],candidates:[{id,unitId,finding,disposition:"pending"|"confirmed"|"rejected"|"duplicate"|"deferred"|"resolved",resolution,resolvedRevision?}],additionalUnits?:[{subsystem,scenario,files,reason}],stopReason${attempt.pass === 'post-fix' ? ',validationRevision:"exact tested workspace HEAD"' : ''}}. Use resolved only in post-fix with resolvedRevision matching the tested HEAD and concrete fix/test evidence in resolution. Omit optional keys rather than spelling question marks in JSON. No extra keys. Include all checkpoints from this attempt in each atomic write. Copy identities and source blob hashes from the ledger. Static reports must account for EVERY file in their unit. Required evidence fields for ${attempt.pass}: ${EVIDENCE_FIELDS[attempt.pass].join(', ')}. Every field needs concrete observations, paths and outcomes, including when no findings survive. Inapplicability needs a scenario-specific reason and evidence in every pass, including independent confirmation; inaccessible evidence is BLOCKED, not inapplicable. Never invent commands, results or inspection evidence. These are agent attestations, not independent proof that tests ran.
Keep all candidates in the register, triage every one, including duplicates/rejections/deferred fixes. Delivery completion is distinct from discovery and does not mean all confirmed findings were remediated. Also preserve the ordinary QUALITY_AUDIT_JSON assessment and completion sentinel; neither a score nor process success can replace this checkpoint. Report missing evidence honestly.`;
}
