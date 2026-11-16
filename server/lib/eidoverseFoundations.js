/**
 * Local-vs-baseline ownership for Eidoverse world foundations and the promote-candidate packaging
 * gate (#7455).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalStringify, isPlainObject } from './objects.js';
import { describeJsonPath, federationSafetyFindings, walkJsonText } from './federationSafety.js';

/** Ownership layers, widest-shared first. See the module header. */
export const EIDOVERSE_FOUNDATION_LAYERS = Object.freeze(['runtime', 'baseline', 'vernacular']);

/** Anything authored on this install starts local. Promotion is explicit. */
export const DEFAULT_EIDOVERSE_FOUNDATION_LAYER = 'vernacular';

/**
 * What a foundation can BE. Deliberately closed — a promote payload a peer cannot classify is a
 * payload it cannot safely inherit.
 */
export const EIDOVERSE_FOUNDATION_KINDS = Object.freeze(['schema', 'affordance', 'controller', 'district-template']);

/**
 * Wire stamp on the promote envelope. The peer pull/inherit slice gates on this; it is
 * deliberately separate from `PORTOS_SCHEMA_VERSIONS`, which versions STORAGE layouts for the
 * record-sync transports this payload does not ride.
 */
export const EIDOVERSE_FOUNDATION_CANDIDATE_VERSION = 3;

/**
 * Keys that are UNAMBIGUOUSLY cosmetic and so must never appear inside a foundation `body`. Found
 * there, they refuse the package.
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

/**
 * The binding between a recorded artifact and the sandbox that proved it survives its author's
 * absence. When an author could supply it, naming a shipped demo fixture was sufficient to clear
 * the promote gate, and the evidence a peer inherited on described that fixture rather than the
 * body in the envelope.
 */
const contributionIdSchema = z.string().trim().min(1).max(120);

/** A shipped-definition / foundation slug. Mirrors `foundationIdSchema`. */
const CONTROLLER_DEFINITION_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The shipped controller definition id a `controller` foundation names, or `null` when its body
 * names none. Exported because `eidoverseFoundationSandbox.js` has to resolve the definition (an
 * async registry read) BEFORE it can build the sandbox.
 */
export function controllerDefinitionIdFromBody(body) {
  const declared = isPlainObject(body) && isPlainObject(body.controller) ? body.controller.definitionId : null;
  return typeof declared === 'string' && CONTROLLER_DEFINITION_SLUG.test(declared.trim()) ? declared.trim() : null;
}

/**
 * The label a foundation's assay evidence is bound to, derived from the record rather than
 * supplied by its author. Lives HERE rather than beside the sandbox that replays the body, even
 * though that is where it is conceptually rooted: both binding checks below call it, and the
 * sandbox reaches the creative toolkit, which reaches this module's input schema — so importing it
 * the other way closes an ESM cycle and leaves `eidoverseFoundationInputSchema` in its temporal
 * dead zone at first load.
 */
export function derivedContributionId({ kind, id, body }) {
  if (kind === 'controller') {
    const definitionId = controllerDefinitionIdFromBody(body);
    if (definitionId) return `controller:${definitionId}`;
  }
  return `${kind}:${id}`;
}

// `.datetime()`, not a `Date.parse` refine: `Date.parse` accepts "March 4, 2026" and "2026", and
// these timestamps are hashed into a payload a peer parses.
const isoDateSchema = z.string().datetime();

const boundedJsonObject = (maxBytes) => z.record(z.string().min(1).max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= maxBytes, `must serialize to at most ${maxBytes} bytes`);

/**
 * The promotable substance. What IS pinned is the size cap and the style/privacy scans below,
 * which is what a receiving peer actually needs to be safe.
 */
const foundationBodySchema = boundedJsonObject(FOUNDATION_LIMITS.jsonBytes);

const foundationStyleSchema = boundedJsonObject(FOUNDATION_LIMITS.jsonBytes);

const foundationDisclosureSchema = z.object({
  requires: z.array(z.string().trim().min(1).max(FOUNDATION_LIMITS.disclosureItemMax)).max(FOUNDATION_LIMITS.disclosureItems).default([]),
  effects: z.array(z.string().trim().min(1).max(FOUNDATION_LIMITS.disclosureItemMax)).max(FOUNDATION_LIMITS.disclosureItems).default([]),
  license: z.string().trim().min(1).max(80).nullable().default(null),
  notes: z.string().trim().min(1).max(FOUNDATION_LIMITS.noteMax).nullable().default(null),
}).strict();

/** Who authored this, at the coarsest grain that is still useful. */
const authorKindSchema = z.enum(['mind', 'cos', 'user']);

const foundationProvenanceSchema = z.object({
  // Callers use `ensureInstanceId()`.
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
 * `sourceInstanceId` and `originInstanceId` are DELIBERATELY separate fields rather than one: a
 * foundation can be re-shared through more than one hop, so the peer this install pulled FROM is
 * not always the install that authored it. Both are opaque instance ids already authorized to
 * travel with a promote envelope — nothing here widens what crosses the federation layer, it only
 * remembers, locally, an edge between two envelopes this install already saw.
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
 * Deliberately a separate field from `inheritance` rather than a variant of it, because the two
 * make opposite claims about who did the work. An `inherited` record is a peer's foundation this
 * install merely stores and may never re-share; a `derived` record IS this install's own work and
 * promotes normally — it just carries, and publishes, the edge back to what it was built from.
 */
export const foundationDerivationEdgeSchema = z.object({
  type: z.literal('derived-from'),
  originInstanceId: instanceIdSchema,
  foundationId: foundationIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/, 'must be a sha256 hex digest'),
  derivedAt: isoDateSchema,
}).strict();

/**
 * What an AUTHOR may claim — which inherited foundation this new body builds on, and nothing more.
 * The digest and the timestamp are deliberately absent: both are stamped from this install's own
 * ledger, so no caller (a route body, a mind tool, a hand-edited file) can mint a derivation edge
 * pointing at a fingerprint or a moment this install never saw.
 */
export const foundationDerivationClaimSchema = z.object({
  originInstanceId: instanceIdSchema,
  foundationId: foundationIdSchema,
}).strict();

/**
 * The fields a foundation carries in every one of its three shapes — the local record, what a
 * caller may author, and the promote envelope. Declared once so a cap change cannot land on two of
 * the three and silently diverge them.
 */
const foundationCoreShape = {
  kind: z.enum(EIDOVERSE_FOUNDATION_KINDS),
  title: z.string().trim().min(1).max(FOUNDATION_LIMITS.titleMax),
  summary: z.string().trim().min(1).max(FOUNDATION_LIMITS.summaryMax),
  body: foundationBodySchema,
  disclosure: foundationDisclosureSchema,
};

/** The local ledger record. `style` stays here and never leaves the install. */
export const eidoverseFoundationRecordSchema = z.object({
  ...foundationCoreShape,
  contributionId: contributionIdSchema,
  id: foundationIdSchema,
  // `runtime` is absent by construction: an install authors its own artifacts and may promote
  // them, but the shared framework layer is never a record here.
  layer: z.enum(['vernacular', 'baseline']),
  style: foundationStyleSchema,
  provenance: foundationProvenanceSchema,
  assay: foundationAssayEvidenceSchema.nullable().default(null),
  // The last packaged envelope, kept verbatim. Deliberately NOT re-validated here: it was gated by
  // `verifyFoundationCandidate` when it was written, and a stored envelope from a newer install
  // must not make the whole record unreadable — the promote path re-verifies the envelope it
  // actually uses.
  candidate: z.unknown().optional(),
  // Set by `promoteEidoverseFoundation()` alongside `layer: 'baseline'`, and cleared when the body
  // is re-authored. `null` on everything this install has only packaged (a dry run) and on every
  // inherited copy, which carries the ORIGIN's `packagedAt` on its inheritance edge instead.
  promotedAt: isoDateSchema.nullable().default(null),
  // `null` for everything this install authored (the overwhelming majority of records). Set only
  // on a LOCAL COPY of a peer's promoted foundation — see `foundationFromInheritedCandidate()`.
  inheritance: foundationInheritanceEdgeSchema.nullable().default(null),
  // `null` on everything authored from nothing. Additive and nullable on a machine-local ledger,
  // so no migration is owed — same argument as `inheritance` above.
  derivedFrom: foundationDerivationEdgeSchema.nullable().default(null),
  updatedAt: isoDateSchema,
}).strict();

export const eidoverseFoundationIdParamSchema = z.object({ id: foundationIdSchema }).strict();

/**
 * A bare id reaches only locally-authored work, because a local vernacular foundation and an
 * inherited copy can legitimately share the same human-readable id — which is exactly why the
 * inherited one lives under `inheritedFoundationStorageKey()`'s disjoint namespace. Naming the
 * origin disambiguates them.
 */
export const eidoverseFoundationTargetSchema = z.object({
  id: foundationIdSchema,
  originInstanceId: instanceIdSchema.nullable().optional().default(null),
}).strict();

/**
 * The ledger key a `{ id, originInstanceId }` ref addresses — the plain id for a locally-authored
 * record, the `peer:` namespace for an inherited copy. The single place either kind of reference
 * becomes a storage key, so a caller never re-derives the namespace and the two can never drift.
 */
export function foundationLedgerKey({ id, originInstanceId = null }) {
  return originInstanceId ? inheritedFoundationStorageKey(originInstanceId, id) : id;
}

/**
 * What a caller (route, mind tool, test) may author. Layer is NOT accepted: a new local artifact
 * is `vernacular` by construction, and moving to `baseline` is what the promote path is for.
 */
export const eidoverseFoundationInputSchema = z.object({
  ...foundationCoreShape,
  id: foundationIdSchema,
  style: foundationStyleSchema.default({}),
  disclosure: foundationDisclosureSchema.default({}),
  authorKind: authorKindSchema.default('user'),
  // A CLAIM, not the edge: see `foundationDerivationClaimSchema`.
  derivedFrom: foundationDerivationClaimSchema.nullable().default(null),
}).strict();

/** The promote envelope — the only shape authorized to cross to a peer. */
export const eidoverseFoundationCandidateSchema = z.object({
  ...foundationCoreShape,
  contributionId: contributionIdSchema,
  candidateVersion: z.literal(EIDOVERSE_FOUNDATION_CANDIDATE_VERSION),
  derivedFrom: foundationDerivationEdgeSchema.nullable().default(null),
  foundationId: foundationIdSchema,
  provenance: foundationProvenanceSchema.extend({
    packagedAt: isoDateSchema,
    portosVersion: z.string().trim().min(1).max(40),
  }).strict(),
  assay: foundationAssayEvidenceSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/, 'must be a sha256 hex digest'),
}).strict();

// --------------------------------------------------------------------------- Ownership
// ---------------------------------------------------------------------------

/**
 * Why this foundation cannot be offered to the shared baseline, or `null` when it can. Returns a
 * reason instead of throwing so the packaging result can report every refusal together rather than
 * surfacing the first one.
 */
export function layerPromoteRefusal(layer) {
  if (layer === 'runtime') return 'runtime is the shared Eidoverse/PortOS framework — it is upstream\'s to change, not an instance\'s to promote';
  if (layer === 'baseline') return 'already part of the shared baseline — promote applies to a local vernacular foundation';
  if (layer === DEFAULT_EIDOVERSE_FOUNDATION_LAYER) return null;
  return `unknown ownership layer "${layer}" — expected one of ${EIDOVERSE_FOUNDATION_LAYERS.join(', ')}`;
}

// --------------------------------------------------------------------------- Safety scans
// ---------------------------------------------------------------------------

/** Style-layer keys found inside a foundation `body`. */
export function styleLeakFindings(body) {
  const findings = [];
  walkJsonText(body, ({ text, path, kind }) => {
    if (kind !== 'key' || !STYLE_ONLY_KEY_SET.has(text)) return;
    findings.push({ code: 'style-in-body', path: describeJsonPath(path), detail: `"${text}" belongs to the vernacular style layer and is never promoted` });
  });
  return findings.slice(0, FOUNDATION_LIMITS.findingsMax);
}

// --------------------------------------------------------------------------- Assay evidence
// ---------------------------------------------------------------------------

/**
 * Fold a `runResilienceAssay()` verdict into the evidence block a candidate carries. Keeping the
 * conversion here (rather than letting each caller shape its own object) is what lets the CLI, a
 * route, and a future mind tool all produce evidence that the same gate can read.
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
 * Why already-schema-parsed assay evidence does not clear the promote gate, or `null`. Both call
 * sites validate the block first (through the record or the candidate schema), so this reads its
 * fields directly.
 */
function assayEvidenceRefusal(assay, requiredDisturbances, contributionId) {
  if (!assay) return 'no agent-free resilience assay has been recorded — run `npm run eidoverse:assay` against this contribution first';
  // The evidence has to be about THIS foundation. Without the binding a passing verdict from any
  // other contribution would clear the gate, which is the borrowed-credential version of the
  // failure the assay exists to catch.
  if (assay.contributionId !== contributionId) {
    return `the recorded assay ran against "${assay.contributionId}", not this foundation's contribution "${contributionId}"`;
  }
  if (!assay.pass) return `the agent-free resilience assay failed: ${assay.reasons[0] || 'no reason recorded'}`;
  const covered = new Set(assay.disturbances);
  const missing = requiredDisturbances.filter((disturbance) => !covered.has(disturbance));
  if (missing.length > 0) return `the recorded assay did not cover every disturbance (missing: ${missing.join(', ')})`;
  return null;
}

// --------------------------------------------------------------------------- Packaging
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
 * The envelope minus its own digest — both the hash input and the privacy-scan input. The digest
 * is excluded from the scan because a sha256 is 64 unbroken hex characters, which is exactly the
 * shape `scrubSecretTokens` treats as a leaked credential; hashing our own hash would be the same
 * mistake.
 */
function withoutFingerprint(candidate) {
  const { fingerprint: _digest, ...rest } = candidate;
  return rest;
}

/**
 * The scan input: the hash input, minus the derivation edge's digest as well. A `derived-from`
 * edge carries the ORIGIN's candidate fingerprint, which is another 64 unbroken hex characters and
 * so trips `scrubSecretTokens` exactly as the envelope's own digest would.
 */
function scannableCandidate(candidate) {
  const rest = withoutFingerprint(candidate);
  if (!rest.derivedFrom || typeof rest.derivedFrom !== 'object') return rest;
  const { fingerprint: _edgeDigest, ...edge } = rest.derivedFrom;
  return { ...rest, derivedFrom: edge };
}

/**
 * A content address for a foundation `body` alone — the same canonicalization the candidate
 * fingerprint uses, so key order and whitespace never decide whether two bodies are "the same
 * work".
 */
export function foundationBodyDigest(body) {
  return createHash('sha256').update(canonicalStringify(body ?? {})).digest('hex');
}

/**
 * The guard this replaces tested `record.inheritance`, a field the authoring path clears
 * unconditionally: loading a peer's foundation into the authoring form and saving it produced a
 * local record stamped with THIS install's origin and no edge at all, which promoted and re-shared
 * cleanly. So the check moved off the mutable flag and onto the bytes: a body that canonicalizes
 * to one this install holds under an inherited key is refused unless the author says what it is
 * derived from.
 * @param {object} options
 * @param {{ originInstanceId: string, foundationId: string }|null} options.claim
 * @param {object} options.body - the body being authored
 * @param {Array<object>} options.inheritedRecords - ledger records carrying an `inheritance` edge
 * @param {object|null} [options.existingEdge] - the edge the record being re-authored already carried
 * @param {string} options.now
 * @returns {{ edge: object|null, refusal: string|null }}
 */
export function resolveFoundationDerivation({ claim, body, inheritedRecords, existingEdge = null, now }) {
  const held = (inheritedRecords || []).filter((entry) => entry?.inheritance && entry?.provenance);
  let edge = existingEdge || null;

  if (claim) {
    const source = held.find((entry) => entry.provenance.originInstanceId === claim.originInstanceId && entry.id === claim.foundationId);
    if (!source) {
      return { edge: null, refusal: `no foundation inherited from install ${claim.originInstanceId} is recorded under "${claim.foundationId}" — a derivation edge names a foundation this install actually holds` };
    }
    const carried = edge && edge.originInstanceId === claim.originInstanceId && edge.foundationId === claim.foundationId;
    edge = {
      type: 'derived-from',
      originInstanceId: claim.originInstanceId,
      foundationId: claim.foundationId,
      fingerprint: source.inheritance.fingerprint,
      derivedAt: carried ? edge.derivedAt : now,
    };
  }

  const digest = foundationBodyDigest(body);
  const copied = held.find((entry) => foundationBodyDigest(entry.body) === digest);
  if (copied && !(edge && edge.originInstanceId === copied.provenance.originInstanceId && edge.foundationId === copied.id)) {
    return {
      edge: null,
      refusal: `this body is byte-for-byte the foundation "${copied.id}" inherited from install ${copied.provenance.originInstanceId} — record it as a derivation of that foundation rather than as this install's own work`,
    };
  }

  return { edge, refusal: null };
}

/**
 * Package a local vernacular foundation into a promote candidate.
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
  const derivedLabel = derivedContributionId(foundation);

  // Two refusals the envelope gate below cannot phrase usefully: ownership layer is not carried on
  // the envelope at all, and a missing assay would surface there as a bare "expected object,
  // received null" rather than as "go run the assay". Everything else — style leak, federation
  // safety, fingerprint, envelope shape — is left to `verifyFoundationCandidate` so the packaging
  // side and the receiving side share one definition of valid.
  const reasons = [
    layerPromoteRefusal(foundation.layer),
    // An inherited record is already `baseline`, so the layer check above does not catch it — and
    // its own reason ("already part of the shared baseline") would be misleading here: this
    // install never promoted it, it pulled a local copy of a foundation ANOTHER install promoted.
    foundation.inheritance ? `inherited from another install (${foundation.inheritance.originInstanceId}) — promotion re-shares only foundations this install authored` : null,
    // `packageEidoverseFoundationCandidate` re-derives before calling in, so this only ever fires
    // on a record that reached the gate some other way.
    foundation.contributionId === derivedLabel
      ? null
      : `this record is labelled "${foundation.contributionId}" but its own kind and body derive "${derivedLabel}" — re-author the foundation so its assay evidence is bound to the body it describes`,
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
    // Published, not just remembered: a receiver that cannot see the edge has no way to tell this
    // install's own work from a body it built on a peer's. Omitted rather than sent as `null` when
    // there is none, so an undecorated v2 envelope hashes over exactly the fields a v1 one did.
    ...(foundation.derivedFrom ? { derivedFrom: foundation.derivedFrom } : {}),
  };
  const candidate = { ...draft, fingerprint: foundationCandidateFingerprint(draft) };

  // Re-read our own output through the envelope gate. The packaging path and the receiving path
  // then share one definition of "valid candidate" rather than two that can drift.
  const verified = verifyFoundationCandidate(candidate, { requiredDisturbances });
  if (!verified.valid) return refused(verified.reasons, verified.findings);

  return { outcome: 'packaged', candidate, reasons: [], findings: [] };
}

/**
 * Validate a candidate envelope — the gate the packaging path runs on its own output and the gate
 * a peer runs on one it was handed. Checks the envelope schema, the content-addressed fingerprint,
 * the assay verdict, and federation safety, and never throws: a malformed candidate is a verdict,
 * not a crash.
 * @returns {{ valid: boolean, reasons: string[], findings: Array }}
 */
export function verifyFoundationCandidate(candidate, { requiredDisturbances }) {
  // Phrased before the schema runs, because `z.literal(3)` reports an OLDER envelope as "invalid
  // literal value" — true, and useless to the human reading a sync log.
  const declaredVersion = candidate?.candidateVersion;
  if (Number.isInteger(declaredVersion) && declaredVersion < EIDOVERSE_FOUNDATION_CANDIDATE_VERSION) {
    return {
      valid: false,
      reasons: [`this promote envelope is candidate v${declaredVersion}; this install requires v${EIDOVERSE_FOUNDATION_CANDIDATE_VERSION}. A pre-v3 envelope's resilience evidence was recorded against a contribution its author NAMED rather than against the body it carries, so it cannot be inherited — ask the origin install to re-package the foundation.`],
      findings: [],
    };
  }

  const parsed = eidoverseFoundationCandidateSchema.safeParse(candidate);
  if (!parsed.success) return { valid: false, reasons: issueReasons(parsed.error), findings: [] };
  const envelope = parsed.data;
  const reasons = [];

  // Hash the candidate AS RECEIVED, not the zod-normalized copy: the digest has to cover the bytes
  // the sender actually hashed. Re-hashing `parsed.data` would let a schema transform (a `.trim()`
  // on a field that arrived padded) read as tampering, including on the packaging side's own
  // self-check.
  if (foundationCandidateFingerprint(candidate) !== envelope.fingerprint) {
    reasons.push('fingerprint does not match the candidate body — the payload was altered after packaging');
  }

  // The label has to be the one THIS envelope's own kind/body derives, not one the sender chose.
  // Re-derivation is pure and reads only the envelope.
  const derivedLabel = derivedContributionId({ kind: envelope.kind, id: envelope.foundationId, body: envelope.body });
  if (envelope.contributionId !== derivedLabel) {
    reasons.push(`this envelope claims to have been replayed as "${envelope.contributionId}", but its own kind and body derive "${derivedLabel}" — the evidence is not about the payload`);
  }

  const assayRefusal = assayEvidenceRefusal(envelope.assay, requiredDisturbances, envelope.contributionId);
  if (assayRefusal) reasons.push(assayRefusal);

  const findings = [...styleLeakFindings(envelope.body), ...federationSafetyFindings(scannableCandidate(envelope))];
  for (const finding of findings) reasons.push(`${finding.path}: ${finding.detail} (${finding.code})`);

  return { valid: reasons.length === 0, reasons, findings };
}


/**
 * The ledger key an inherited foundation is stored under — deliberately disjoint from any id
 * `recordEidoverseFoundation()` can ever author, so pulling a peer's foundation never touches,
 * shadows, or can collide with a local vernacular foundation that happens to share the same
 * foundation id. Both `foundationIdSchema` (a plain lowercase slug) and `instanceIdSchema` (opaque
 * alphanumeric/dash/underscore) forbid colons, which is what makes this `:`-delimited namespace
 * collision-proof rather than merely unlikely.
 */
export function inheritedFoundationStorageKey(originInstanceId, foundationId) {
  return `peer:${originInstanceId}:${foundationId}`;
}

/**
 * Build a local ledger record for a foundation candidate this install pulled from a peer. The
 * candidate is re-verified through the EXACT gate a peer runs on one it was handed
 * (`verifyFoundationCandidate`): schema, the content-addressed fingerprint, the assay evidence
 * already embedded in the envelope, and federation safety (machine identity, PII, credentials).
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
  // A separate check from the one above: `sourceInstanceId` is the peer this install pulled FROM,
  // which is not always who AUTHORED the candidate (a foundation can be re-shared through more
  // than one hop). "Pulled from myself" is its own nonsensical edge even when the origin is
  // genuinely someone else, and the schema validation below cannot catch it — it only checks that
  // the field is a well-formed opaque id, not that it differs from `localInstanceId`.
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
    // Copied verbatim off the envelope (absent on a v1 one, which reads back as `null`): the
    // origin told us its own work was derived from a third install's, and dropping that here would
    // truncate the chain to the last hop on every install downstream of it.
    derivedFrom: envelope.derivedFrom ?? null,
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
 * Proposal → commit → promote — and, for a local copy of a peer's, → inherit — as an ORDERED,
 * read-only projection over fields the record already persists. No new storage: a ledger written
 * before this function existed still projects a correct lineage the instant it is read, which is
 * what lets `docs/STORAGE.md`'s "no migration owed" hold for this change too.
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

  if (record.derivedFrom) {
    events.push({
      type: 'derived',
      at: record.derivedFrom.derivedAt,
      originInstanceId: record.derivedFrom.originInstanceId,
      foundationId: record.derivedFrom.foundationId,
      fingerprint: record.derivedFrom.fingerprint,
    });
  }

  if (record.assay?.ranAt) {
    events.push({ type: 'assayed', at: record.assay.ranAt, pass: record.assay.pass === true });
  }

  // Skipped on an inherited record: its `candidate` is the envelope it was BUILT from, so
  // `packaged` would just restate the `inherited` event above under a different name.
  if (!record.inheritance && record.candidate?.provenance?.packagedAt) {
    events.push({ type: 'packaged', at: record.candidate.provenance.packagedAt, fingerprint: record.candidate.fingerprint ?? null });
  }

  // An inherited record's `promotedAt` is always `null` (see the schema comment) — this install
  // never promoted it, it pulled a copy.
  if (!record.inheritance && record.promotedAt) {
    events.push({ type: 'promoted', at: record.promotedAt });
  }

  return events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// --------------------------------------------------------------------------- Projection
// ---------------------------------------------------------------------------

/**
 * A ledger record reduced to what a MODEL needs to reason about promotion. The full record carries
 * `style`, the whole `body`, and the last candidate envelope — kilobytes of install-local
 * cosmetics and duplicated substance that would ride into every prompt turn for no decision value.
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
    // `null` is "no assay has been run", which is a different state from a recorded failing
    // verdict — never collapse the two into `false`.
    assayPass: record?.assay ? record.assay.pass === true : null,
    assayReasons: record?.assay?.reasons?.slice(0, 5) ?? [],
    promoteRefusal: layerPromoteRefusal(record?.layer),
    provenance: record?.provenance
      ? { originInstanceId: record.provenance.originInstanceId ?? null, authorKind: record.provenance.authorKind ?? null, createdAt: record.provenance.createdAt ?? null }
      : null,
    inheritance: record?.inheritance ?? null,
    derivedFrom: record?.derivedFrom ?? null,
    lineage: foundationLineage(record),
  };
}

/**
 * Why this is a second projection rather than a widened first one: the list is read every time a
 * mind wonders what exists here, and a list of whole bodies is kilobytes of substance per entry
 * riding into a prompt to answer a question about ids. The choice of WHICH body to read is a
 * decision the mind makes after the list, so the body belongs on the read-one.
 */
export function detailFoundation(record) {
  if (!record) return null;
  return {
    ...summarizeFoundation(record),
    body: record.body ?? null,
    disclosure: record.disclosure ?? null,
  };
}


/**
 * What `body.controller` must look like for a `controller` foundation to be adoptable — the recipe
 * an install replays to stand the thing up locally. `config` is validated only as bounded JSON
 * here; the CONTROLLER's own `configSchema` is what actually gates it, and that lives in the
 * shipped registry that `installEidoverseController()` resolves.
 */
const foundationControllerBodySchema = z.object({
  definitionId: z.string().trim().min(1).max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase slug (letters, digits, hyphens)'),
  config: boundedJsonObject(FOUNDATION_LIMITS.jsonBytes).default({}),
  tickIntervalMs: z.number().int().positive().optional(),
  placement: z.record(z.string().min(1).max(64), z.unknown()).optional(),
}).strict();

/**
 * Decide what adopting a foundation MEANS for its kind, as a pure verdict. Refusals are RESULTS
 * with a named reason, never throws, and never silent successes.
 * @param {object|null} record - a ledger record
 * @returns {{ outcome: 'plan'|'refused', plan: object|null, reasons: string[] }}
 */
export function planFoundationAdoption(record) {
  const refusedPlan = (reason) => ({ outcome: 'refused', plan: null, reasons: [reason] });
  if (!record) return refusedPlan('no foundation is recorded under that reference');

  // Adoption applies to a copy of a PEER's foundation. A local record needs no adopting — its
  // author already has every way to install it — and letting this path touch one would make
  // "adopt" a second, edgeless authoring route into the controller runtime.
  if (!record.inheritance) {
    return refusedPlan('this foundation was authored on this install — adoption applies to a local copy of a peer\'s foundation, which this install installs directly instead');
  }

  if (record.kind === 'controller') {
    const parsed = foundationControllerBodySchema.safeParse(record.body?.controller);
    if (!parsed.success) {
      return refusedPlan(`this controller foundation's body.controller is not an installable recipe: ${issueReasons(parsed.error).join('; ')}`);
    }
    return {
      outcome: 'plan',
      plan: {
        kind: 'controller',
        install: {
          id: record.id,
          controllerId: parsed.data.definitionId,
          config: parsed.data.config,
          ...(parsed.data.tickIntervalMs ? { tickIntervalMs: parsed.data.tickIntervalMs } : {}),
          ...(parsed.data.placement ? { placement: parsed.data.placement } : {}),
          // Both false, and NOT negotiable by the envelope: adopting a peer's controller must
          // never, in one tool call, produce a thing that is already ticking and already allowed
          // to speak and build in the world. Arming it and letting it deliver are separate, local
          // acts.
          armed: false,
          deliverEffects: false,
        },
        derivedFrom: {
          type: 'derived-from',
          originInstanceId: record.inheritance.originInstanceId,
          foundationId: record.inheritance.foundationId,
          fingerprint: record.inheritance.fingerprint,
          derivedAt: record.inheritance.inheritedAt,
        },
      },
      reasons: [],
    };
  }

  if (record.kind === 'district-template') {
    return refusedPlan('district-template adoption needs the layout replay path — nothing on this install turns a template body into geometry yet (#7627)');
  }

  return refusedPlan(`a "${record.kind}" foundation is a declaration with no interpreter on this install — there is nothing for adoption to stand up`);
}
