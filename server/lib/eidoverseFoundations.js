/**
 * Local-vs-baseline ownership for Eidoverse world foundations, plus the
 * packaging/validation step that turns one instance's vernacular artifact into
 * a promote candidate for the shared PortOS baseline (#7455, epic #7453).
 *
 * SwarmWorld's federation shape, as Adam put it: fork locally, contribute
 * foundations globally. Three ownership layers carry that:
 *
 *   - `runtime`    — the shared Eidoverse/PortOS framework. Upstream owns it;
 *                    an instance never authors into it and never promotes it.
 *   - `baseline`   — the shared promoted-foundation population a peer can pull
 *                    and inherit.
 *   - `vernacular` — this install's own style and buildings.
 *
 * `vernacular` is the DEFAULT for everything authored locally, so nothing is
 * ever shared by omission — promoting is an explicit act with a gate in front
 * of it, never the absence of a "keep this private" flag.
 *
 * A foundation is `{ body, style }` by construction rather than one bag with a
 * blocklist. `body` is the promotable substance (declared schema, affordance,
 * optional controller spec); `style` is the cosmetics that make this install's
 * Commons look like itself (palette, motif, asset paths, placement, district,
 * display aliases). `packageFoundationCandidate()` carries `body` and drops
 * `style` outright, which is what makes "a peer inherits the foundation without
 * its author's cosmetics overwriting the peer's style layer" a property of the
 * payload instead of a merge rule some later receiver has to get right. A
 * style-only key found INSIDE `body` refuses the package rather than being
 * silently stripped: quietly promoting an author's accent color as though it
 * were substance is the failure this split exists to prevent.
 *
 * Two gates run before a candidate exists at all:
 *
 *   1. **Agent-free resilience evidence.** `services/eidoverseResilienceAssay.js`
 *      (#7460) already decides whether a contribution still works with its
 *      author mind gone. This module consumes its VERDICT rather than running
 *      the contribution itself: `assayEvidenceFromVerdict()` folds a
 *      `runResilienceAssay()` result into the evidence block, and packaging
 *      refuses evidence that is missing, failing, bound to a DIFFERENT
 *      contribution than the one this foundation names, or short of the full
 *      disturbance suite. Keeping execution in the harness that owns the
 *      sandbox leaves this module pure and synchronous, and leaves exactly one
 *      place in the tree that runs untrusted controller code. The ledger runs
 *      the assay fresh on every package attempt, so evidence is never older
 *      than the body it vouches for.
  *   2. **Federation safety.** A promote payload is the one durable Eidoverse
 *      artifact authorized to cross the federation layer, alongside live guest
 *      conversation, so it fails closed: `lib/federationSafety.js` refuses the
 *      package outright when the candidate carries machine identity, PII,
 *      credential-shaped values or credential-NAMED fields, naming the
 *      offending JSON path. Nothing is redacted and shipped — a redacted
 *      promote would leave the author believing they published what they
 *      wrote. See the "PII must not ride the federation layer" rule in root
 *      `AGENTS.md` and the federated Eidoverse foundations ADR
 *      (docs/decisions/2026-09-18-federated-eidoverse-foundations.md).
 *
 * `fingerprint` is content-addressed (sha256 over the canonicalized envelope
 * minus the fingerprint itself), so a peer can verify a candidate it was handed
 * and the provenance graph (#7461) has a stable artifact identity to hang edges
 * from.
 *
 * Pure: no I/O, no clock of its own (callers pass `now`), no provider calls.
 * The persisted ledger lives in `services/eidoverseFoundationLedger.js`.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalStringify } from './objects.js';
import { describeJsonPath, federationSafetyFindings, walkJsonText } from './federationSafety.js';

/** Ownership layers, widest-shared first. See the module header. */
export const EIDOVERSE_FOUNDATION_LAYERS = Object.freeze(['runtime', 'baseline', 'vernacular']);

/** Anything authored on this install starts local. Promotion is explicit. */
export const DEFAULT_EIDOVERSE_FOUNDATION_LAYER = 'vernacular';

/** What a foundation can BE. Deliberately closed — a promote payload a peer
 * cannot classify is a payload it cannot safely inherit. */
export const EIDOVERSE_FOUNDATION_KINDS = Object.freeze(['schema', 'affordance', 'controller', 'district-template']);

/** Wire stamp on the promote envelope. The peer pull/inherit slice gates on
 * this; it is deliberately separate from `PORTOS_SCHEMA_VERSIONS`, which
 * versions STORAGE layouts for the record-sync transports this payload does
 * not ride. */
export const EIDOVERSE_FOUNDATION_CANDIDATE_VERSION = 1;

/**
 * Keys that are UNAMBIGUOUSLY cosmetic and so must never appear inside a
 * foundation `body`. Found there, they refuse the package.
 *
 * This is an authoring check on top of the `{ body, style }` split, not the
 * mechanism — the split already guarantees `style` never leaves the install.
 * It exists because "I put the palette in `body` and expected peers to get it"
 * is a mistake worth naming rather than silently dropping.
 *
 * Kept narrow on purpose. Spatial and asset-binding keys (`pos`, `yaw`,
 * `lib`, `placement`, `districtId`) are NOT listed even though a vernacular
 * layout uses them: they are exactly the substance of a `district-template`
 * foundation, and blocking them would make one of the four declared kinds
 * impossible to promote.
 */
const STYLE_ONLY_KEYS = Object.freeze([
  'accent', 'alias', 'aliases', 'avatar', 'color', 'colors', 'labelAliases',
  'material', 'materials', 'motif', 'palette', 'texture', 'textures',
]);

const STYLE_ONLY_KEY_SET = new Set(STYLE_ONLY_KEYS);

const FOUNDATION_LIMITS = Object.freeze({
  idMax: 64,
  titleMax: 80,
  summaryMax: 400,
  jsonBytes: 16_384,
  disclosureItems: 12,
  disclosureItemMax: 160,
  noteMax: 600,
  findingsMax: 40,
});

const foundationIdSchema = z.string().trim().min(1).max(FOUNDATION_LIMITS.idMax)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase slug (letters, digits, hyphens)');

/** The resilience-assay contribution this foundation is replayed as — the
 * binding between a recorded artifact and the sandbox that proves it survives
 * its author's absence. Resolved by `services/eidoverseResilienceContributions.js`. */
const contributionIdSchema = z.string().trim().min(1).max(120);

// `.datetime()`, not a `Date.parse` refine: `Date.parse` accepts "March 4, 2026"
// and "2026", and these timestamps are hashed into a payload a peer parses.
const isoDateSchema = z.string().datetime();

const boundedJsonObject = (maxBytes) => z.record(z.string().min(1).max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= maxBytes, `must serialize to at most ${maxBytes} bytes`);

/** The promotable substance. Free-form beneath the top level on purpose: the
 * controller/affordance vocabulary is still being written (#7456), and pinning
 * it here would make every vocabulary addition a schema migration. What IS
 * pinned is the size cap and the style/privacy scans below, which is what a
 * receiving peer actually needs to be safe. */
const foundationBodySchema = boundedJsonObject(FOUNDATION_LIMITS.jsonBytes);

const foundationStyleSchema = boundedJsonObject(FOUNDATION_LIMITS.jsonBytes);

const foundationDisclosureSchema = z.object({
  requires: z.array(z.string().trim().min(1).max(FOUNDATION_LIMITS.disclosureItemMax)).max(FOUNDATION_LIMITS.disclosureItems).default([]),
  effects: z.array(z.string().trim().min(1).max(FOUNDATION_LIMITS.disclosureItemMax)).max(FOUNDATION_LIMITS.disclosureItems).default([]),
  license: z.string().trim().min(1).max(80).nullable().default(null),
  notes: z.string().trim().min(1).max(FOUNDATION_LIMITS.noteMax).nullable().default(null),
}).strict();

/**
 * Who authored this, at the coarsest grain that is still useful. The instance
 * id is PortOS's own opaque federation identity — never a hostname, never a
 * tailnet name — and there is deliberately NO author display name: the richer
 * agent-artifact provenance graph is #7461's to design, and a name added here
 * "for now" is a privacy decision made by accident.
 */
const authorKindSchema = z.enum(['mind', 'cos', 'user']);

const foundationProvenanceSchema = z.object({
  // `UNKNOWN_INSTANCE_ID` is refused here rather than at each call site: this
  // id is content-addressed into the candidate fingerprint and is what the
  // provenance graph (#7461) hangs its edges off, so a candidate stamped
  // "unknown" would be permanently misattributed and would collide with every
  // other uninitialized install. Callers use `ensureInstanceId()`.
  originInstanceId: z.string().trim().min(1).max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'must be an opaque instance id')
    .refine((id) => id !== 'unknown', 'this install has no federation identity yet'),
  authorKind: authorKindSchema,
  createdAt: isoDateSchema,
}).strict();

const foundationAssayEvidenceSchema = z.object({
  harness: z.literal('eidoverse-resilience-assay'),
  contributionId: contributionIdSchema,
  pass: z.boolean(),
  disturbances: z.array(z.string().trim().min(1).max(64)).min(1).max(16),
  ranAt: isoDateSchema,
  reasons: z.array(z.string().trim().min(1).max(400)).max(FOUNDATION_LIMITS.findingsMax).default([]),
}).strict();

/** Opaque PortOS federation instance id — never a hostname, never a tailnet name. */
const instanceIdSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'must be an opaque instance id');

/**
 * The one provenance-graph edge PortOS records today: "this install's local
 * copy of `foundationId` is a pull of the candidate a peer packaged, from
 * origin `originInstanceId` by way of `sourceInstanceId`." (#7461)
 *
 * `sourceInstanceId` and `originInstanceId` are DELIBERATELY separate fields
 * rather than one: a foundation can be re-shared through more than one hop, so
 * the peer this install pulled FROM is not always the install that authored
 * it. Both are opaque instance ids already authorized to travel with a promote
 * envelope — nothing here widens what crosses the federation layer, it only
 * remembers, locally, an edge between two envelopes this install already saw.
 *
 * `fingerprint` + `packagedAt` are copied from the candidate this edge was
 * built from, so the edge stays meaningful even if the local copy's `candidate`
 * field is ever dropped (the pattern the ledger already uses for a
 * re-authored `baseline` foundation losing its packaged envelope).
 */
export const foundationInheritanceEdgeSchema = z.object({
  type: z.literal('inherited-from'),
  originInstanceId: instanceIdSchema,
  foundationId: foundationIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/, 'must be a sha256 hex digest'),
  packagedAt: isoDateSchema,
  sourceInstanceId: instanceIdSchema,
  inheritedAt: isoDateSchema,
}).strict();

/**
 * The fields a foundation carries in every one of its three shapes — the local
 * record, what a caller may author, and the promote envelope. Declared once so
 * a cap change cannot land on two of the three and silently diverge them.
 */
const foundationCoreShape = {
  kind: z.enum(EIDOVERSE_FOUNDATION_KINDS),
  title: z.string().trim().min(1).max(FOUNDATION_LIMITS.titleMax),
  summary: z.string().trim().min(1).max(FOUNDATION_LIMITS.summaryMax),
  contributionId: contributionIdSchema,
  body: foundationBodySchema,
  disclosure: foundationDisclosureSchema,
};

/** The local ledger record. `style` stays here and never leaves the install. */
export const eidoverseFoundationRecordSchema = z.object({
  ...foundationCoreShape,
  id: foundationIdSchema,
  // `runtime` is absent by construction: an install authors its own artifacts
  // and may promote them, but the shared framework layer is never a record here.
  layer: z.enum(['vernacular', 'baseline']),
  style: foundationStyleSchema,
  provenance: foundationProvenanceSchema,
  assay: foundationAssayEvidenceSchema.nullable().default(null),
  // The last packaged envelope, kept verbatim. Deliberately NOT re-validated
  // here: it was gated by `verifyFoundationCandidate` when it was written, and
  // a stored envelope from a newer install must not make the whole record
  // unreadable — the promote path re-verifies the envelope it actually uses.
  candidate: z.unknown().optional(),
  // Set by `promoteEidoverseFoundation()` alongside `layer: 'baseline'`, and
  // cleared when the body is re-authored. `null` on everything this install has
  // only packaged (a dry run) and on every inherited copy, which carries the
  // ORIGIN's `packagedAt` on its inheritance edge instead.
  promotedAt: isoDateSchema.nullable().default(null),
  // `null` for everything this install authored (the overwhelming majority of
  // records). Set only on a LOCAL COPY of a peer's promoted foundation — see
  // `foundationFromInheritedCandidate()`. Absent entirely on a record written
  // before this field existed, which reads back as `null` through this same
  // default — an additive nullable field on the machine-local ledger, so no
  // migration is owed (`docs/STORAGE.md`'s entry for `foundations.json`).
  inheritance: foundationInheritanceEdgeSchema.nullable().default(null),
  updatedAt: isoDateSchema,
}).strict();

export const eidoverseFoundationIdParamSchema = z.object({ id: foundationIdSchema }).strict();

/** What a caller (route, mind tool, test) may author. Layer is NOT accepted:
 * a new local artifact is `vernacular` by construction, and moving to
 * `baseline` is what the promote path is for. */
export const eidoverseFoundationInputSchema = z.object({
  ...foundationCoreShape,
  id: foundationIdSchema,
  style: foundationStyleSchema.default({}),
  disclosure: foundationDisclosureSchema.default({}),
  authorKind: authorKindSchema.default('user'),
}).strict();

/** The promote envelope — the only shape authorized to cross to a peer. */
export const eidoverseFoundationCandidateSchema = z.object({
  ...foundationCoreShape,
  candidateVersion: z.literal(EIDOVERSE_FOUNDATION_CANDIDATE_VERSION),
  foundationId: foundationIdSchema,
  provenance: foundationProvenanceSchema.extend({
    packagedAt: isoDateSchema,
    portosVersion: z.string().trim().min(1).max(40),
  }).strict(),
  assay: foundationAssayEvidenceSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/, 'must be a sha256 hex digest'),
}).strict();

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * Why this foundation cannot be offered to the shared baseline, or `null` when
 * it can. Returns a reason instead of throwing so the packaging result can
 * report every refusal together rather than surfacing the first one.
 */
export function layerPromoteRefusal(layer) {
  if (layer === 'runtime') return 'runtime is the shared Eidoverse/PortOS framework — it is upstream\'s to change, not an instance\'s to promote';
  if (layer === 'baseline') return 'already part of the shared baseline — promote applies to a local vernacular foundation';
  if (layer === DEFAULT_EIDOVERSE_FOUNDATION_LAYER) return null;
  return `unknown ownership layer "${layer}" — expected one of ${EIDOVERSE_FOUNDATION_LAYERS.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Safety scans
// ---------------------------------------------------------------------------

/**
 * Style-layer keys found inside a foundation `body`. These refuse the package:
 * the split is what keeps an inheriting peer's own cosmetics intact, so a
 * foundation that smuggles its author's accent color through `body` has to be
 * fixed rather than quietly trimmed.
 */
export function styleLeakFindings(body) {
  const findings = [];
  walkJsonText(body, ({ text, path, kind }) => {
    if (kind !== 'key' || !STYLE_ONLY_KEY_SET.has(text)) return;
    findings.push({ code: 'style-in-body', path: describeJsonPath(path), detail: `"${text}" belongs to the vernacular style layer and is never promoted` });
  });
  return findings.slice(0, FOUNDATION_LIMITS.findingsMax);
}

// ---------------------------------------------------------------------------
// Assay evidence
// ---------------------------------------------------------------------------

/**
 * Fold a `runResilienceAssay()` verdict into the evidence block a candidate
 * carries. Keeping the conversion here (rather than letting each caller shape
 * its own object) is what lets the CLI, a route, and a future mind tool all
 * produce evidence that the same gate can read.
 *
 * @param {{contributionId?: string, pass?: boolean, scenarios?: Array, reasons?: string[]}} verdict
 * @param {{ranAt: string}} options
 */
export function assayEvidenceFromVerdict(verdict, { ranAt }) {
  return {
    harness: 'eidoverse-resilience-assay',
    contributionId: verdict?.contributionId || 'unknown-contribution',
    pass: verdict?.pass === true,
    disturbances: (verdict?.scenarios || []).map((scenario) => scenario?.disturbance).filter((id) => typeof id === 'string' && id.length > 0),
    ranAt,
    reasons: (verdict?.reasons || []).slice(0, FOUNDATION_LIMITS.findingsMax).map((reason) => String(reason).slice(0, 400)),
  };
}

/**
 * Why already-schema-parsed assay evidence does not clear the promote gate, or
 * `null`. Both call sites validate the block first (through the record or the
 * candidate schema), so this reads its fields directly.
 *
 * `requiredDisturbances` is passed in rather than imported so this pure module
 * never reaches into the service layer; callers hand it
 * `RESILIENCE_DISTURBANCES` from `services/eidoverseResilienceAssay.js`.
 */
function assayEvidenceRefusal(assay, requiredDisturbances, contributionId) {
  if (!assay) return 'no agent-free resilience assay has been recorded — run `npm run eidoverse:assay` against this contribution first';
  // The evidence has to be about THIS foundation. Without the binding a passing
  // verdict from any other contribution would clear the gate, which is the
  // borrowed-credential version of the failure the assay exists to catch.
  if (assay.contributionId !== contributionId) {
    return `the recorded assay ran against "${assay.contributionId}", not this foundation's contribution "${contributionId}"`;
  }
  if (!assay.pass) return `the agent-free resilience assay failed: ${assay.reasons[0] || 'no reason recorded'}`;
  const covered = new Set(assay.disturbances);
  const missing = requiredDisturbances.filter((disturbance) => !covered.has(disturbance));
  if (missing.length > 0) return `the recorded assay did not cover every disturbance (missing: ${missing.join(', ')})`;
  return null;
}

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

/** Zod issues as reader-facing reasons, capped like every other finding list. */
const issueReasons = (error) => error.issues
  .slice(0, FOUNDATION_LIMITS.findingsMax)
  .map((issue) => `${describeJsonPath(issue.path.map(String))}: ${issue.message}`);

const refused = (reasons, findings = []) => ({ outcome: 'refused', candidate: null, reasons, findings });

/** sha256 over the canonicalized envelope, excluding the digest itself. */
export function foundationCandidateFingerprint(candidate) {
  return createHash('sha256').update(canonicalStringify(withoutFingerprint(candidate))).digest('hex');
}

/**
 * The envelope minus its own digest — both the hash input and the privacy-scan
 * input. The digest is excluded from the scan because a sha256 is 64 unbroken
 * hex characters, which is exactly the shape `scrubSecretTokens` treats as a
 * leaked credential; hashing our own hash would be the same mistake.
 */
function withoutFingerprint(candidate) {
  const { fingerprint: _digest, ...rest } = candidate;
  return rest;
}

/**
 * Package a local vernacular foundation into a promote candidate.
 *
 * @param {object} options
 * @param {object} options.record - a ledger record (see `eidoverseFoundationRecordSchema`)
 * @param {string[]} options.requiredDisturbances - the assay's full disturbance suite
 * @param {string} options.portosVersion
 * @param {string} options.now - ISO timestamp supplied by the caller
 * @returns {{ outcome: 'packaged'|'refused', candidate: object|null, reasons: string[], findings: Array }}
 */
export function packageFoundationCandidate({ record, requiredDisturbances, portosVersion, now }) {
  const parsed = eidoverseFoundationRecordSchema.safeParse(record);
  if (!parsed.success) return refused(issueReasons(parsed.error));
  const foundation = parsed.data;

  // Two refusals the envelope gate below cannot phrase usefully: ownership
  // layer is not carried on the envelope at all, and a missing assay would
  // surface there as a bare "expected object, received null" rather than as
  // "go run the assay". Everything else — style leak, federation safety,
  // fingerprint, envelope shape — is left to `verifyFoundationCandidate` so the
  // packaging side and the receiving side share one definition of valid.
  const reasons = [
    layerPromoteRefusal(foundation.layer),
    // An inherited record is already `baseline`, so the layer check above
    // does not catch it — and its own reason ("already part of the shared
    // baseline") would be misleading here: this install never promoted it,
    // it pulled a local copy of a foundation ANOTHER install promoted.
    // Promotion publishes only what this install authored (#7461); it must
    // never become a relay that re-shares a peer's foundation as its own.
    foundation.inheritance ? `inherited from another install (${foundation.inheritance.originInstanceId}) — promotion re-shares only foundations this install authored` : null,
    assayEvidenceRefusal(foundation.assay, requiredDisturbances, foundation.contributionId),
  ].filter(Boolean);
  if (reasons.length > 0) return refused(reasons);

  const draft = {
    candidateVersion: EIDOVERSE_FOUNDATION_CANDIDATE_VERSION,
    foundationId: foundation.id,
    kind: foundation.kind,
    title: foundation.title,
    summary: foundation.summary,
    contributionId: foundation.contributionId,
    body: foundation.body,
    disclosure: foundation.disclosure,
    provenance: { ...foundation.provenance, packagedAt: now, portosVersion },
    assay: foundation.assay,
  };
  const candidate = { ...draft, fingerprint: foundationCandidateFingerprint(draft) };

  // Re-read our own output through the envelope gate. The packaging path and
  // the receiving path then share one definition of "valid candidate" rather
  // than two that can drift.
  const verified = verifyFoundationCandidate(candidate, { requiredDisturbances });
  if (!verified.valid) return refused(verified.reasons, verified.findings);

  return { outcome: 'packaged', candidate, reasons: [], findings: [] };
}

/**
 * Validate a candidate envelope — the gate the packaging path runs on its own
 * output and the gate a peer runs on one it was handed. Checks the envelope
 * schema, the content-addressed fingerprint, the assay verdict, and federation
 * safety, and never throws: a malformed candidate is a verdict, not a crash.
 *
 * @returns {{ valid: boolean, reasons: string[], findings: Array }}
 */
export function verifyFoundationCandidate(candidate, { requiredDisturbances }) {
  const parsed = eidoverseFoundationCandidateSchema.safeParse(candidate);
  if (!parsed.success) return { valid: false, reasons: issueReasons(parsed.error), findings: [] };
  const envelope = parsed.data;
  const reasons = [];

  // Hash the candidate AS RECEIVED, not the zod-normalized copy: the digest has
  // to cover the bytes the sender actually hashed. Re-hashing `parsed.data`
  // would let a schema transform (a `.trim()` on a field that arrived padded)
  // read as tampering, including on the packaging side's own self-check.
  if (foundationCandidateFingerprint(candidate) !== envelope.fingerprint) {
    reasons.push('fingerprint does not match the candidate body — the payload was altered after packaging');
  }

  const assayRefusal = assayEvidenceRefusal(envelope.assay, requiredDisturbances, envelope.contributionId);
  if (assayRefusal) reasons.push(assayRefusal);

  const findings = [...styleLeakFindings(envelope.body), ...federationSafetyFindings(withoutFingerprint(envelope))];
  for (const finding of findings) reasons.push(`${finding.path}: ${finding.detail} (${finding.code})`);

  return { valid: reasons.length === 0, reasons, findings };
}

// ---------------------------------------------------------------------------
// Provenance graph (#7461)
// ---------------------------------------------------------------------------

/**
 * The ledger key an inherited foundation is stored under — deliberately
 * disjoint from any id `recordEidoverseFoundation()` can ever author, so
 * pulling a peer's foundation never touches, shadows, or can collide with a
 * local vernacular foundation that happens to share the same foundation id.
 * Both `foundationIdSchema` (a plain lowercase slug) and `instanceIdSchema`
 * (opaque alphanumeric/dash/underscore) forbid colons, which is what makes
 * this `:`-delimited namespace collision-proof rather than merely unlikely.
 */
export function inheritedFoundationStorageKey(originInstanceId, foundationId) {
  return `peer:${originInstanceId}:${foundationId}`;
}

/**
 * Build a local ledger record for a foundation candidate this install pulled
 * from a peer. `recordEidoverseFoundationInheritance()` in
 * `services/eidoverseFoundationLedger.js` is the only caller; the peer
 * pull/inherit transport that drives it is
 * `services/sharing/peerEidoverseFoundationSync.js` (#7455).
 *
 * The candidate is re-verified through the EXACT gate a peer runs on one it
 * was handed (`verifyFoundationCandidate`): schema, the content-addressed
 * fingerprint, the assay evidence already embedded in the envelope, and
 * federation safety (machine identity, PII, credentials). A payload handed
 * over by a peer is untrusted input, so this never trusts "it was already
 * promoted, so it must be clean" — a candidate that fails is refused outright,
 * never stored redacted. Nothing here RE-RUNS the resilience assay or
 * executes the contribution: that ran on the author's install, and replaying
 * arbitrary controller code pulled from a peer here is exactly what the
 * assay harness exists to keep off every OTHER install.
 *
 * `style` is never part of the envelope, so the local copy always starts with
 * an empty one — it looks like this install's own Commons only once someone
 * here deliberately re-styles it, same as any other baseline foundation.
 *
 * Refuses (never throws) a self-referential pull — a peer handing back a
 * foundation this install itself originated: "inherited from myself" is not
 * a provenance edge, it is a loop.
 *
 * @param {object} options
 * @param {object} options.candidate - a promote envelope, as received from a peer
 * @param {string[]} options.requiredDisturbances
 * @param {string} options.sourceInstanceId - the peer this install pulled FROM
 * @param {string} options.localInstanceId - this install's own federation id
 * @param {string} options.now - ISO timestamp supplied by the caller
 * @returns {{ outcome: 'inherited'|'refused', foundation: object|null, reasons: string[], findings: Array }}
 */
export function foundationFromInheritedCandidate({ candidate, requiredDisturbances, sourceInstanceId, localInstanceId, now }) {
  const inheritanceRefused = (reasons, findings = []) => ({ outcome: 'refused', foundation: null, reasons, findings });

  if (!localInstanceId) return inheritanceRefused(['this install has no federation identity yet — inheritance cannot check for a self-referential pull']);

  const verified = verifyFoundationCandidate(candidate, { requiredDisturbances });
  if (!verified.valid) return inheritanceRefused(verified.reasons, verified.findings);

  const envelope = candidate;
  if (envelope.provenance.originInstanceId === localInstanceId) {
    return inheritanceRefused(['this candidate originated on this install — inheritance applies to another install\'s foundation, not a copy of your own']);
  }
  // A separate check from the one above: `sourceInstanceId` is the peer this
  // install pulled FROM, which is not always who AUTHORED the candidate (a
  // foundation can be re-shared through more than one hop). "Pulled from
  // myself" is its own nonsensical edge even when the origin is genuinely
  // someone else, and the schema validation below cannot catch it — it only
  // checks that the field is a well-formed opaque id, not that it differs
  // from `localInstanceId`.
  if (sourceInstanceId === localInstanceId) {
    return inheritanceRefused(['this install cannot be the peer it pulled the candidate from']);
  }

  const draft = {
    id: envelope.foundationId,
    layer: 'baseline',
    kind: envelope.kind,
    title: envelope.title,
    summary: envelope.summary,
    contributionId: envelope.contributionId,
    body: envelope.body,
    style: {},
    provenance: {
      originInstanceId: envelope.provenance.originInstanceId,
      authorKind: envelope.provenance.authorKind,
      createdAt: envelope.provenance.createdAt,
    },
    disclosure: envelope.disclosure,
    assay: envelope.assay,
    candidate: envelope,
    promotedAt: null,
    inheritance: {
      type: 'inherited-from',
      originInstanceId: envelope.provenance.originInstanceId,
      foundationId: envelope.foundationId,
      fingerprint: envelope.fingerprint,
      packagedAt: envelope.provenance.packagedAt,
      sourceInstanceId,
      inheritedAt: now,
    },
    updatedAt: now,
  };

  const parsed = eidoverseFoundationRecordSchema.safeParse(draft);
  if (!parsed.success) return { outcome: 'refused', foundation: null, reasons: issueReasons(parsed.error), findings: [] };

  return { outcome: 'inherited', foundation: parsed.data, reasons: [], findings: [] };
}

/**
 * Proposal → commit → promote — and, for a local copy of a peer's, → inherit
 * — as an ORDERED, read-only projection over fields the record already
 * persists. No new storage: a ledger written before this function existed
 * still projects a correct lineage the instant it is read, which is what lets
 * `docs/STORAGE.md`'s "no migration owed" hold for this change too.
 *
 * @param {object|null} record
 * @returns {Array<{ type: string, at: string, [key: string]: unknown }>}
 */
export function foundationLineage(record) {
  if (!record) return [];
  const events = [];

  if (record.inheritance) {
    events.push({
      type: 'inherited',
      at: record.inheritance.inheritedAt,
      originInstanceId: record.inheritance.originInstanceId,
      foundationId: record.inheritance.foundationId,
      sourceInstanceId: record.inheritance.sourceInstanceId,
      fingerprint: record.inheritance.fingerprint,
    });
  } else if (record.provenance?.createdAt) {
    events.push({
      type: 'authored',
      at: record.provenance.createdAt,
      authorKind: record.provenance.authorKind ?? null,
      originInstanceId: record.provenance.originInstanceId ?? null,
    });
  }

  if (record.assay?.ranAt) {
    events.push({ type: 'assayed', at: record.assay.ranAt, pass: record.assay.pass === true });
  }

  // Skipped on an inherited record: its `candidate` is the envelope it was
  // BUILT from, so `packaged` would just restate the `inherited` event above
  // under a different name.
  if (!record.inheritance && record.candidate?.provenance?.packagedAt) {
    events.push({ type: 'packaged', at: record.candidate.provenance.packagedAt, fingerprint: record.candidate.fingerprint ?? null });
  }

  // An inherited record's `promotedAt` is always `null` (see the schema
  // comment) — this install never promoted it, it pulled a copy.
  if (!record.inheritance && record.promotedAt) {
    events.push({ type: 'promoted', at: record.promotedAt });
  }

  return events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * A ledger record reduced to what a MODEL needs to reason about promotion.
 *
 * The full record carries `style`, the whole `body`, and the last candidate
 * envelope — kilobytes of install-local cosmetics and duplicated substance that
 * would ride into every prompt turn for no decision value. This keeps the
 * ownership layer, the identity, the assay outcome and whether a gated
 * candidate currently exists, which is exactly what "can I promote this, and if
 * not why" needs. `style` is omitted rather than trimmed: a mind that never
 * sees the cosmetics cannot narrate them into a promote body.
 *
 * `provenance`, `inheritance`, and `lineage` (#7461) are the provenance-graph
 * projection: who authored this (an opaque instance id and coarse author
 * kind — never a display name, per the provenance-privacy note on
 * `foundationProvenanceSchema`), whether it is a local copy of a PEER's
 * foundation, and the ordered proposal → commit → promote/inherit timeline.
 * All three are already either stored on the record or cheaply derived from
 * it, so surfacing them here costs a mind nothing it was not already paying
 * for through the full-record GET routes.
 */
export function summarizeFoundation(record) {
  return {
    id: record?.id ?? null,
    layer: record?.layer ?? null,
    kind: record?.kind ?? null,
    title: record?.title ?? null,
    summary: record?.summary ?? null,
    contributionId: record?.contributionId ?? null,
    promotedAt: record?.promotedAt ?? null,
    updatedAt: record?.updatedAt ?? null,
    hasCandidate: Boolean(record?.candidate),
    // `null` is "no assay has been run", which is a different state from a
    // recorded failing verdict — never collapse the two into `false`.
    assayPass: record?.assay ? record.assay.pass === true : null,
    assayReasons: record?.assay?.reasons?.slice(0, 5) ?? [],
    promoteRefusal: layerPromoteRefusal(record?.layer),
    provenance: record?.provenance
      ? { originInstanceId: record.provenance.originInstanceId ?? null, authorKind: record.provenance.authorKind ?? null, createdAt: record.provenance.createdAt ?? null }
      : null,
    inheritance: record?.inheritance ?? null,
    lineage: foundationLineage(record),
  };
}
