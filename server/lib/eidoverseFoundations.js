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
 *   2. **Federation safety.** A promote payload is the one Eidoverse artifact
 *      authorized to cross the federation layer, so it fails closed: machine
 *      identity, PII, home/Windows paths, IP or MAC literals, and
 *      credential-shaped values anywhere in the candidate REFUSE the package
 *      with the offending JSON path named. Nothing is redacted and shipped —
 *      a redacted promote would leave the author believing they published what
 *      they wrote. See the "PII must not ride the federation layer" rule in
 *      root `AGENTS.md` and the machine-local privacy ADR.
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
import { scrubSecretTokens } from './secretText.js';

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

/** Storage-layout version stamped on `data/eidoverse/foundations.json`. */
export const EIDOVERSE_FOUNDATION_LEDGER_SCHEMA_VERSION = 1;

/**
 * Keys that belong to the vernacular style layer and must never appear inside a
 * foundation `body`. Found there, they refuse the package — see the header.
 */
export const EIDOVERSE_STYLE_ONLY_KEYS = Object.freeze([
  'accent', 'alias', 'aliases', 'asset', 'assets', 'avatar', 'color', 'colors',
  'district', 'districtId', 'labelAliases', 'lib', 'material', 'materials',
  'motif', 'palette', 'placement', 'pos', 'texture', 'textures', 'yaw',
]);

const STYLE_ONLY_KEY_SET = new Set(EIDOVERSE_STYLE_ONLY_KEYS);

export const FOUNDATION_LIMITS = Object.freeze({
  idMax: 64,
  titleMax: 80,
  summaryMax: 400,
  bodyBytes: 16_384,
  styleBytes: 16_384,
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

const isoDateSchema = z.string().trim().min(1).max(40).refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'must be an ISO-8601 timestamp',
);

const boundedJsonObject = (maxBytes) => z.record(z.string().min(1).max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= maxBytes, `must serialize to at most ${maxBytes} bytes`);

/** The promotable substance. Free-form beneath the top level on purpose: the
 * controller/affordance vocabulary is still being written (#7456), and pinning
 * it here would make every vocabulary addition a schema migration. What IS
 * pinned is the size cap and the style/privacy scans below, which is what a
 * receiving peer actually needs to be safe. */
const foundationBodySchema = boundedJsonObject(FOUNDATION_LIMITS.bodyBytes);

const foundationStyleSchema = boundedJsonObject(FOUNDATION_LIMITS.styleBytes);

export const foundationDisclosureSchema = z.object({
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
export const foundationProvenanceSchema = z.object({
  originInstanceId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'must be an opaque instance id'),
  authorKind: z.enum(['mind', 'cos', 'user']),
  createdAt: isoDateSchema,
}).strict();

export const foundationAssayEvidenceSchema = z.object({
  harness: z.literal('eidoverse-resilience-assay'),
  contributionId: contributionIdSchema,
  pass: z.boolean(),
  disturbances: z.array(z.string().trim().min(1).max(64)).min(1).max(16),
  ranAt: isoDateSchema,
  reasons: z.array(z.string().trim().min(1).max(400)).max(FOUNDATION_LIMITS.findingsMax).default([]),
}).strict();

/** The local ledger record. `style` stays here and never leaves the install. */
export const eidoverseFoundationRecordSchema = z.object({
  id: foundationIdSchema,
  layer: z.enum(['vernacular', 'baseline']),
  kind: z.enum(EIDOVERSE_FOUNDATION_KINDS),
  title: z.string().trim().min(1).max(FOUNDATION_LIMITS.titleMax),
  summary: z.string().trim().min(1).max(FOUNDATION_LIMITS.summaryMax),
  contributionId: contributionIdSchema,
  body: foundationBodySchema,
  style: foundationStyleSchema,
  provenance: foundationProvenanceSchema,
  disclosure: foundationDisclosureSchema,
  assay: foundationAssayEvidenceSchema.nullable().default(null),
  // The last packaged envelope, kept verbatim. Deliberately NOT re-validated
  // here: it was gated by `verifyFoundationCandidate` when it was written, and
  // a stored envelope from a newer install must not make the whole record
  // unreadable — the promote path re-verifies the envelope it actually uses.
  candidate: z.unknown().optional(),
  promotedAt: isoDateSchema.nullable().default(null),
  updatedAt: isoDateSchema,
}).strict();

/** The `:id` route parameter — the same slug contract as a record's own id. */
export const eidoverseFoundationIdParamSchema = z.object({ id: foundationIdSchema }).strict();

/** What a caller (route, mind tool, test) may author. Layer is NOT accepted:
 * a new local artifact is `vernacular` by construction, and moving to
 * `baseline` is what the promote path is for. */
export const eidoverseFoundationInputSchema = z.object({
  id: foundationIdSchema,
  kind: z.enum(EIDOVERSE_FOUNDATION_KINDS),
  title: z.string().trim().min(1).max(FOUNDATION_LIMITS.titleMax),
  summary: z.string().trim().min(1).max(FOUNDATION_LIMITS.summaryMax),
  contributionId: contributionIdSchema,
  body: foundationBodySchema,
  style: foundationStyleSchema.default({}),
  disclosure: foundationDisclosureSchema.default({}),
  authorKind: z.enum(['mind', 'cos', 'user']).default('user'),
}).strict();

/** The promote envelope — the only shape authorized to cross to a peer. */
export const eidoverseFoundationCandidateSchema = z.object({
  candidateVersion: z.literal(EIDOVERSE_FOUNDATION_CANDIDATE_VERSION),
  foundationId: foundationIdSchema,
  kind: z.enum(EIDOVERSE_FOUNDATION_KINDS),
  title: z.string().trim().min(1).max(FOUNDATION_LIMITS.titleMax),
  summary: z.string().trim().min(1).max(FOUNDATION_LIMITS.summaryMax),
  contributionId: contributionIdSchema,
  body: foundationBodySchema,
  disclosure: foundationDisclosureSchema,
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

const PRIVACY_PATTERNS = Object.freeze([
  // `/Users/<name>/…`, `/home/<name>/…` — the OS username by another name.
  ['home-path', /(?:^|[\s"'`(])(?:\/Users|\/home)\/[^/\s"'`]+/i],
  // `C:\Users\<name>` and any other Windows drive-absolute path.
  ['windows-path', /\b[A-Za-z]:[\\/](?:Users[\\/])?[^\s"'`]+/],
  // Dotted quads. A four-part version string is refused too, and deliberately:
  // the payload leaves this machine, so "looks like an address" is the right
  // side to fail on, and the finding names the exact JSON path to fix.
  ['ip-literal', /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/],
  // Tailscale MagicDNS and mDNS names.
  ['network-host', /\b[A-Za-z0-9-]+\.(?:ts\.net|local)\b/i],
  ['mac-address', /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/],
  ['email-address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
]);

const describePath = (path) => (path.length === 0 ? '<root>' : path.join('.'));

/**
 * Walk a JSON-shaped value once, reporting every string it contains AND every
 * object key it passes through. Keys matter as much as values here: a key named
 * for a host leaks the host, and a key is what the style-layer scan looks at.
 *
 * @param {unknown} value
 * @param {(entry: { text: string, path: string[], kind: 'key'|'value' }) => void} visit
 */
function walkJsonText(value, visit, path = []) {
  if (typeof value === 'string') {
    visit({ text: value, path, kind: 'value' });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkJsonText(child, visit, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    visit({ text: key, path: childPath, kind: 'key' });
    walkJsonText(child, visit, childPath);
  }
}

/**
 * Machine identity / PII / credential findings anywhere in a JSON-shaped value.
 *
 * @returns {Array<{ code: string, path: string, detail: string }>}
 */
export function federationSafetyFindings(value) {
  const findings = [];
  walkJsonText(value, ({ text, path }) => {
    for (const [code, pattern] of PRIVACY_PATTERNS) {
      if (pattern.test(text)) findings.push({ code, path: describePath(path), detail: `a ${code.replace('-', ' ')} may not cross the federation layer` });
    }
    if (scrubSecretTokens(text) !== text) {
      findings.push({ code: 'secret-token', path: describePath(path), detail: 'a credential-shaped value may not cross the federation layer' });
    }
  });
  return findings.slice(0, FOUNDATION_LIMITS.findingsMax);
}

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
    findings.push({ code: 'style-in-body', path: describePath(path), detail: `"${text}" belongs to the vernacular style layer and is never promoted` });
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
 * Why the recorded assay evidence does not clear the promote gate, or `null`.
 *
 * `requiredDisturbances` is passed in rather than imported so this pure module
 * never reaches into the service layer; callers hand it
 * `RESILIENCE_DISTURBANCES` from `services/eidoverseResilienceAssay.js`.
 */
export function assayEvidenceRefusal(assay, requiredDisturbances, { contributionId } = {}) {
  if (!assay) return 'no agent-free resilience assay has been recorded — run `npm run eidoverse:assay` against this contribution first';
  const parsed = foundationAssayEvidenceSchema.safeParse(assay);
  if (!parsed.success) return `recorded assay evidence is malformed: ${parsed.error.issues[0]?.message || 'unreadable'}`;
  // The evidence has to be about THIS foundation. Without the binding a passing
  // verdict from any other contribution would clear the gate, which is the
  // borrowed-credential version of the failure the assay exists to catch.
  if (contributionId && parsed.data.contributionId !== contributionId) {
    return `the recorded assay ran against "${parsed.data.contributionId}", not this foundation's contribution "${contributionId}"`;
  }
  if (!parsed.data.pass) return `the agent-free resilience assay failed: ${parsed.data.reasons[0] || 'no reason recorded'}`;
  const covered = new Set(parsed.data.disturbances);
  const missing = requiredDisturbances.filter((disturbance) => !covered.has(disturbance));
  if (missing.length > 0) return `the recorded assay did not cover every disturbance (missing: ${missing.join(', ')})`;
  return null;
}

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

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
  if (!parsed.success) {
    return {
      outcome: 'refused',
      candidate: null,
      reasons: parsed.error.issues.slice(0, FOUNDATION_LIMITS.findingsMax).map((issue) => `${describePath(issue.path.map(String))}: ${issue.message}`),
      findings: [],
    };
  }
  const foundation = parsed.data;

  // Two refusals the envelope gate below cannot phrase usefully: ownership
  // layer is not carried on the envelope at all, and a missing assay would
  // surface there as a bare "expected object, received null" rather than as
  // "go run the assay". Everything else — style leak, federation safety,
  // fingerprint, envelope shape — is left to `verifyFoundationCandidate` so the
  // packaging side and the receiving side share one definition of valid.
  const reasons = [
    layerPromoteRefusal(foundation.layer),
    assayEvidenceRefusal(foundation.assay, requiredDisturbances, { contributionId: foundation.contributionId }),
  ].filter(Boolean);
  if (reasons.length > 0) return { outcome: 'refused', candidate: null, reasons, findings: [] };

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
  if (!verified.valid) return { outcome: 'refused', candidate: null, reasons: verified.reasons, findings: verified.findings };

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
  if (!parsed.success) {
    return {
      valid: false,
      reasons: parsed.error.issues.slice(0, FOUNDATION_LIMITS.findingsMax).map((issue) => `${describePath(issue.path.map(String))}: ${issue.message}`),
      findings: [],
    };
  }
  const envelope = parsed.data;
  const reasons = [];

  if (foundationCandidateFingerprint(envelope) !== envelope.fingerprint) {
    reasons.push('fingerprint does not match the candidate body — the payload was altered after packaging');
  }

  const assayRefusal = assayEvidenceRefusal(envelope.assay, requiredDisturbances, { contributionId: envelope.contributionId });
  if (assayRefusal) reasons.push(assayRefusal);

  const findings = [...styleLeakFindings(envelope.body), ...federationSafetyFindings(withoutFingerprint(envelope))];
  for (const finding of findings) reasons.push(`${finding.path}: ${finding.detail} (${finding.code})`);

  return { valid: reasons.length === 0, reasons, findings };
}
