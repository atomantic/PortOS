/**
 * The install-local ledger of Eidoverse world foundations — which durable
 * artifacts this instance authored or inherited, which ownership layer each
 * one sits in, and the last promote candidate packaged from (or inheritance
 * edge built for) it (#7455, #7461, epic #7453).
 *
 * `server/lib/eidoverseFoundations.js` owns the ownership model and the
 * packaging gate; this module is the persistence, clock, and assay shell.
 * Authored records land at `vernacular`; a local copy of a peer's promoted
 * foundation lands at `baseline` with an `inherited-from` edge. A record built
 * on an inherited copy (#7631) carries a `derived-from` edge, and
 * `recordEidoverseFoundation()` refuses an inherited body that names none.
 *
 * The promote gate runs the agent-free assay and never accepts a caller verdict:
 * the sandbox is derived from the foundation's own body (#7625), so "what was
 * evaluated" and "what gets promoted" are the same object.
 *
 * Storage: `file-primary` (`data/eidoverse/foundations.json`) — machine-local,
 * never federated as records: only a promoted foundation's packaged candidate
 * envelope (`listPromotedFoundationCandidates()`, served by
 * `services/sharing/peerEidoverseFoundationSync.js`, version-gated as
 * `eidoverseFoundations`) leaves the install, never the `style` layer. Inherited
 * records live under disjoint `peer:<origin>:<id>` keys. No `data.reference/` seed
 * or migration: an absent file is the empty ledger and additions are nullable.
 *
 * Withdrawal (#7632) records a TOMBSTONE keyed on the candidate's
 * content-addressed fingerprint; it rides the offering so a receiver DROPS its
 * copy (`applyEidoverseFoundationTombstones()`).
 */

import { join } from 'node:path';
import { PATHS, atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { getPortosVersion } from '../lib/schemaVersions.js';
import {
  DEFAULT_EIDOVERSE_FOUNDATION_LAYER,
  assayEvidenceFromVerdict,
  derivedContributionId,
  eidoverseFoundationInputSchema,
  foundationFromInheritedCandidate,
  foundationLedgerKey,
  foundationLineage,
  inheritedFoundationStorageKey,
  packageFoundationCandidate,
  planFoundationAdoption,
  resolveFoundationDerivation,
  verifyFoundationCandidate,
} from '../lib/eidoverseFoundations.js';
import { ServerError } from '../lib/errorHandler.js';
import { generateDistrictTemplatePlacement } from '../lib/eidoverseCreativeToolkit.js';
import {
  clearTombstone,
  normalizeTombstones,
  recordTombstone,
  tombstoneTimestamp,
} from '../lib/tombstones.js';
import { RESILIENCE_DISTURBANCES, runResilienceAssay } from './eidoverseResilienceAssay.js';
import { foundationSandbox } from '../lib/eidoverseFoundationSandbox.js';
import { findControllerDefinitionById } from './eidoverseControllerRegistry.js';

/**
 * Storage-layout version. The `tombstones` key is additive in both directions,
 * so no bump; an older PortOS rewriting the file drops pending tombstones
 * (re-withdrawing records them again).
 */
const LEDGER_SCHEMA_VERSION = 1;

/**
 * Tombstones key on the candidate's `fingerprint` (sha256 of the canonical
 * envelope, same on every install, matches `inheritance.fingerprint`), not the
 * local foundation id.
 */
const TOMBSTONE_KEY_FIELD = 'fingerprint';

/** Capped apart from the transport's offering cap: a retraction must never be displaced by a publication. */
const TOMBSTONE_LIMIT = 200;

const tombstoneOptions = { keyField: TOMBSTONE_KEY_FIELD, limit: TOMBSTONE_LIMIT };

// Read `PATHS` per call, not `dataPath()`: suites redirect the data root by
// proxying this module's `fileUtils` import, which `dataPath()` never sees.
const ledgerFile = () => join(PATHS.data, 'eidoverse', 'foundations.json');

const withLedgerLock = createMutex();

/**
 * Strict read: an unparseable `foundations.json` must not read as "no
 * foundations", or the next write would replace the ledger with an empty one.
 */
async function readLedger() {
  const raw = await readJSONFile(ledgerFile(), null, { allowArray: false, strict: true });
  const stored = raw && typeof raw === 'object' ? raw : {};
  return {
    foundations: stored.foundations && typeof stored.foundations === 'object' ? { ...stored.foundations } : {},
    // Normalized on read too: a peer's offering also writes this list and humans can edit the file.
    tombstones: normalizeTombstones(stored.tombstones, TOMBSTONE_KEY_FIELD),
  };
}

/** The foundations map alone, for the read-only paths that never write back. */
const readFoundations = async () => (await readLedger()).foundations;

// Both halves are always written together; defaulting tombstones would erase pending retractions.
async function writeLedger({ foundations, tombstones }) {
  await atomicWrite(ledgerFile(), {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    foundations,
    tombstones: normalizeTombstones(tombstones, TOMBSTONE_KEY_FIELD),
  });
}

/**
 * Every foundation this install knows about, most recently updated first —
 * authored and inherited. `lineage` is derived on every read, not stored.
 */
export async function listEidoverseFoundations() {
  const foundations = Object.values(await readFoundations())
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const counts = foundations.reduce((totals, entry) => ({
    vernacular: totals.vernacular + (entry.layer === 'vernacular' ? 1 : 0),
    baseline: totals.baseline + (entry.layer === 'baseline' ? 1 : 0),
    candidates: totals.candidates + (entry.candidate ? 1 : 0),
    // A subset of `baseline`: pulled from a peer rather than promoted locally.
    inherited: totals.inherited + (entry.inheritance ? 1 : 0),
  }), { vernacular: 0, baseline: 0, candidates: 0, inherited: 0 });
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    counts,
    foundations: foundations.map((entry) => ({ ...entry, lineage: foundationLineage(entry) })),
  };
}

/**
 * The promote envelopes this install OFFERS to federated peers (#7455), behind
 * `GET /api/peer-sync/eidoverse-foundations`. Three filters:
 *
 *  - `layer === 'baseline'`: a packaged `vernacular` candidate is a dry run,
 *    not a publication.
 *  - `!inheritance`: never re-share another install's work (matches
 *    `packageEidoverseFoundationCandidate`).
 *  - the candidate still VERIFIES: the file is hand-editable, and refuse-never-redact
 *    applies outbound too, so a failing candidate is dropped and logged.
 *
 * Returns envelopes only, never ledger records (their `style` layer must not leave).
 */
export async function listPromotedFoundationCandidates() {
  const { foundations, tombstones } = await readLedger();
  const offerable = Object.values(foundations)
    .filter((entry) => entry?.layer === 'baseline' && !entry.inheritance && entry.candidate);
  const candidates = [];
  for (const entry of offerable) {
    // Backstop: promoting clears the tombstone, but a hand-edited ledger could carry both,
    // which receivers would resolve differently. The retraction wins.
    if (tombstoneTimestamp(tombstones, entry.candidate.fingerprint, TOMBSTONE_KEY_FIELD) !== null) {
      console.warn(`⚠️ Eidoverse foundation "${entry.id}" is promoted but its candidate is withdrawn — withholding it from the peer offering`);
      continue;
    }
    const verified = verifyFoundationCandidate(entry.candidate, { requiredDisturbances: RESILIENCE_DISTURBANCES });
    if (!verified.valid) {
      console.warn(`⚠️ Eidoverse foundation "${entry.id}" is promoted but its stored candidate no longer passes the promote gate — withholding it from the peer offering (${verified.reasons.length} reason(s))`);
      continue;
    }
    candidates.push(entry.candidate);
  }
  // Fingerprint order: content-addressed, so the offering (and the listHash a
  // receiver short-circuits on) is stable across ledger read order.
  return candidates.sort((a, b) => String(a.fingerprint).localeCompare(String(b.fingerprint)));
}

export async function getEidoverseFoundation(id) {
  const found = (await readFoundations())[id] || null;
  return found ? { ...found, lineage: foundationLineage(found) } : null;
}

/**
 * One foundation by REFERENCE — `{ id, originInstanceId }` — the only way an
 * inherited copy is addressable (#7626): those live under
 * `inheritedFoundationStorageKey()`'s disjoint `peer:` namespace, which a plain
 * id never reaches. `originInstanceId: null` means "authored here", never
 * "whichever matches".
 */
export async function getEidoverseFoundationByRef(ref) {
  return getEidoverseFoundation(foundationLedgerKey(ref));
}

/**
 * ADOPT a foundation inherited from a peer — stand its `body` up as something
 * that runs here, carrying a `derived-from` edge back to the origin (#7626).
 *
 * What adoption does is decided per KIND by `planFoundationAdoption()`; a kind
 * with no interpreter is REFUSED BY NAME. Only `controller` is adoptable, and the
 * peer names which SHIPPED controller to run, never code: `definitionId` resolves
 * against this install's fixed registry, so adopting never executes a peer's
 * bytes. The install lands DISARMED with `deliverEffects: false`.
 *
 * A refusal is a RESULT with its reasons.
 *
 * @returns {Promise<{ outcome: 'adopted'|'refused'|'unknown-foundation', install: object|null, reasons: string[] }>}
 */
export async function adoptEidoverseFoundation(ref, { installedBy = 'user' } = {}) {
  const key = foundationLedgerKey(ref);
  const record = await getEidoverseFoundation(key);
  if (!record) return { outcome: 'unknown-foundation', install: null, reasons: [`no foundation is recorded under "${key}"`] };

  const planned = planFoundationAdoption(record);
  if (planned.outcome !== 'plan') return { outcome: 'refused', install: null, reasons: planned.reasons };

  const { getEidoverseControllerInstall, installEidoverseController } = await import('./eidoverseControllerRuntime.js');

  // The install id is the foundation's id, so re-adoption updates one install. Refuse when
  // it names a controller not derived from this foundation rather than retarget it at a peer's config.
  const occupant = await getEidoverseControllerInstall(planned.plan.install.id);
  const sameSource = occupant?.derivedFrom
    && occupant.derivedFrom.originInstanceId === planned.plan.derivedFrom.originInstanceId
    && occupant.derivedFrom.foundationId === planned.plan.derivedFrom.foundationId;
  if (occupant && !sameSource) {
    return {
      outcome: 'refused',
      install: null,
      reasons: [`a controller is already installed under "${planned.plan.install.id}" and was not adopted from this foundation — retire it first rather than letting an adopt overwrite a controller already running here`],
    };
  }

  const result = await installEidoverseController(planned.plan.install, { installedBy, derivedFrom: planned.plan.derivedFrom });
  if (result.outcome !== 'installed') return { outcome: 'refused', install: null, reasons: result.reasons };
  console.log(`🧬 Eidoverse: adopted foundation "${record.id}" from origin ${planned.plan.derivedFrom.originInstanceId} as disarmed controller "${result.install.id}"`);
  return { outcome: 'adopted', install: result.install, reasons: [] };
}

/**
 * A `district-template` body's `placement` is DERIVED, never trusted from the
 * caller (#7627): the deterministic seeded generator replays
 * `{layoutId, anchor, seed}` as a peer does on inherit, and a disagreeing
 * caller value is REPLACED wholesale. A body missing `layoutId` or `anchor`
 * is returned unchanged.
 */
function deriveDistrictTemplateBody(authored) {
  if (authored.kind !== 'district-template') return authored.body;
  const { layoutId, anchor, propCount, seed, facing } = authored.body;
  if (typeof layoutId !== 'string' || !Array.isArray(anchor)) return authored.body;
  const placement = generateDistrictTemplatePlacement({ layoutId, anchor, propCount, seed, facing });
  return { ...authored.body, placement };
}

/**
 * Record (or re-author) a local vernacular foundation.
 *
 * `originInstanceId` is caller-supplied (`getInstanceId()`) to keep this a
 * single-purpose store.
 *
 * Re-authoring keeps the original `createdAt` and origin and CLEARS the
 * packaged candidate and assay, which described the previous body. A
 * re-authored `baseline` foundation drops back to `vernacular` with
 * `promotedAt` cleared: the promoted bytes no longer exist here, and
 * `layerPromoteRefusal` would refuse to package a `baseline` record anyway.
 */
export async function recordEidoverseFoundation(input, { originInstanceId, now = new Date().toISOString() } = {}) {
  const authored = eidoverseFoundationInputSchema.parse(input);
  return withLedgerLock(async () => {
    const { foundations, tombstones } = await readLedger();
    const existing = foundations[authored.id] || null;
    // Republish guard (#7631): check the body as it will be STORED (a district-template's
    // `placement` is derived, so a re-submitted recipe would otherwise digest differently
    // and slip past) against every inherited copy. Thrown, not returned, because callers
    // treat the return value as the saved record.
    const body = deriveDistrictTemplateBody(authored);
    const derivation = resolveFoundationDerivation({
      claim: authored.derivedFrom,
      body,
      inheritedRecords: Object.values(foundations),
      existingEdge: existing?.derivedFrom || null,
      now,
    });
    if (derivation.refusal) throw new ServerError(derivation.refusal, { status: 409 });
    const record = {
      id: authored.id,
      layer: DEFAULT_EIDOVERSE_FOUNDATION_LAYER,
      kind: authored.kind,
      title: authored.title,
      summary: authored.summary,
      // DERIVED (#7625) from the stored body the sandbox will replay; a caller-named label
      // could point the gate at a shipped demo fixture.
      contributionId: derivedContributionId({ kind: authored.kind, id: authored.id, body }),
      body,
      style: authored.style,
      provenance: existing?.provenance || { originInstanceId, authorKind: authored.authorKind, createdAt: now },
      disclosure: authored.disclosure,
      assay: null,
      candidate: null,
      promotedAt: null,
      // Always `null`: this path authors LOCAL work under the plain id, never the peer namespace.
      inheritance: null,
      derivedFrom: derivation.edge,
      updatedAt: now,
    };
    foundations[authored.id] = record;
    // Re-authoring a PROMOTED foundation retracts the published body: tombstone the
    // replaced candidate's fingerprint (the new body publishes under a new one).
    await writeLedger({ foundations, tombstones: tombstoneForReplacedCandidate(tombstones, existing, now) });
    return record;
  });
}

/**
 * Tombstone a candidate a write replaces, but only if it was actually published:
 * a merely PACKAGED `vernacular` candidate never left the install.
 */
const wasPublished = (entry) => entry?.layer === 'baseline' && !entry.inheritance && typeof entry.candidate?.fingerprint === 'string';

function tombstoneForReplacedCandidate(tombstones, existing, now) {
  if (!wasPublished(existing)) return tombstones;
  return recordTombstone(tombstones, existing.candidate.fingerprint, { ...tombstoneOptions, deletedAt: now });
}

const verdict = (outcome, reasons) => ({ outcome, candidate: null, assay: null, reasons, findings: [] });
const unknownFoundation = (id) => verdict('unknown-foundation', [`no foundation is recorded under "${id}"`]);

/**
 * Run the agent-free assay against a recorded foundation and, if every gate
 * passes, package the promote candidate onto its record.
 *
 * A refusal is a RESULT, not an exception. The assay verdict is persisted either
 * way, while a refusal clears any earlier candidate since its verdict no longer holds.
 *
 * @returns {Promise<{ outcome: 'packaged'|'refused'|'unknown-foundation', candidate: object|null, assay: object|null, reasons: string[], findings: Array }>}
 */
export async function packageEidoverseFoundationCandidate(id, { now = new Date().toISOString() } = {}) {
  const existing = await getEidoverseFoundation(id);
  if (!existing) return unknownFoundation(id);
  // Refused before replaying anything: the pure lib also refuses inherited records, but only
  // after running the assay on a body that came from a peer.
  if (existing.inheritance) {
    return verdict('refused', [`inherited from another install (${existing.inheritance.originInstanceId}) — promotion re-shares only foundations this install authored`]);
  }

  // Outside the ledger lock (replay is slow and reads no ledger); the lock below re-checks
  // the body was not re-authored. The sandbox derives from the foundation's own body (#7625);
  // a body with no derivable sandbox is refused.
  const { contribution, refusal } = await foundationSandbox(existing, { findControllerDefinition: findControllerDefinitionById });
  if (refusal) return verdict('refused', [refusal]);
  const assay = assayEvidenceFromVerdict(runResilienceAssay(contribution), { ranAt: now });
  // After the early returns: `getPortosVersion()` re-parses package.json on every call.
  const portosVersion = await getPortosVersion();

  return withLedgerLock(async () => {
    const { foundations, tombstones } = await readLedger();
    const current = foundations[id];
    if (!current) return unknownFoundation(id);
    if (current.updatedAt !== existing.updatedAt) {
      return verdict('refused', ['the foundation was re-authored while the assay was running — package it again']);
    }

    // `contributionId` is re-derived so a pre-#7625 or restored record heals on the next package.
    const result = packageFoundationCandidate({
      record: { ...current, contributionId: contribution.id, assay, candidate: null },
      requiredDisturbances: RESILIENCE_DISTURBANCES,
      portosVersion,
      now,
    });
    // `updatedAt` tracks the BODY's authorship, not assay runs; bumping it would trip the
    // optimistic check above. A refusal also clears the previous candidate.
    foundations[id] = { ...current, contributionId: contribution.id, assay, candidate: result.candidate };
    await writeLedger({ foundations, tombstones });
    return { ...result, assay };
  });
}

/**
 * Promote a packaged foundation into this install's shared baseline.
 *
 * Re-packages first and publishes the candidate it just produced, so every gate
 * is re-run against the body as it stands now. A refusal is a RESULT; nothing
 * moves layer.
 *
 * `baseline` is exactly what `listPromotedFoundationCandidates()` serves at
 * `GET /api/peer-sync/eidoverse-foundations`. The record keeps its `style`
 * locally; only the candidate envelope crosses
 * (docs/decisions/2026-09-18-federated-eidoverse-foundations.md).
 *
 * @returns {Promise<{ outcome: 'promoted'|'refused'|'unknown-foundation', promoted: boolean, foundation: object|null, candidate: object|null, assay: object|null, reasons: string[], findings: Array }>}
 */
export async function promoteEidoverseFoundation(id, { now = new Date().toISOString() } = {}) {
  const packaged = await packageEidoverseFoundationCandidate(id, { now });
  if (packaged.outcome !== 'packaged') return { ...packaged, promoted: false, foundation: null };

  return withLedgerLock(async () => {
    const { foundations, tombstones } = await readLedger();
    const current = foundations[id];
    if (!current) return { ...unknownFoundation(id), promoted: false, foundation: null };
    // Packaging released the lock; a re-author in the gap clears the candidate, and publishing would ship ungated bytes.
    if (current.candidate?.fingerprint !== packaged.candidate.fingerprint) {
      return {
        outcome: 'refused',
        promoted: false,
        foundation: null,
        candidate: null,
        assay: packaged.assay,
        reasons: ['the foundation was re-authored while it was being packaged — promote it again'],
        findings: [],
      };
    }
    const foundation = { ...current, layer: 'baseline', promotedAt: now };
    foundations[id] = foundation;
    // Re-publishing a withdrawn body clears its tombstone: the fingerprint is content-addressed,
    // so only an explicit clear distinguishes "changed my mind" from "never withdrew".
    await writeLedger({ foundations, tombstones: clearTombstone(tombstones, packaged.candidate.fingerprint, TOMBSTONE_KEY_FIELD) });
    return { ...packaged, outcome: 'promoted', promoted: true, foundation };
  });
}

/**
 * Accept a promote candidate pulled from a peer and store it as a local
 * baseline copy with an `inherited-from` edge (#7461).
 *
 * The caller is the transport in `services/sharing/peerEidoverseFoundationSync.js`;
 * `sourceInstanceId` is the peer pulled FROM, which differs from the candidate's
 * `originInstanceId` on a multi-hop re-share. `localInstanceId` is caller-supplied.
 *
 * Every sending-side gate (schema, fingerprint, assay evidence, federation
 * safety) runs again here: a peer payload is untrusted input. A failing
 * candidate is refused and nothing is written, never redacted. It is stored
 * under the disjoint `inheritedFoundationStorageKey()` namespace so it cannot
 * shadow a local foundation of the same id.
 *
 * @returns {Promise<{ outcome: 'inherited'|'refused', foundation: object|null, reasons: string[], findings: Array }>}
 */
export async function recordEidoverseFoundationInheritance(candidate, { sourceInstanceId, localInstanceId, now = new Date().toISOString() } = {}) {
  const built = foundationFromInheritedCandidate({
    candidate, requiredDisturbances: RESILIENCE_DISTURBANCES, sourceInstanceId, localInstanceId, now,
  });
  if (built.outcome !== 'inherited') return built;

  return withLedgerLock(async () => {
    const { foundations, tombstones } = await readLedger();
    const originInstanceId = built.foundation.provenance.originInstanceId;
    const key = inheritedFoundationStorageKey(originInstanceId, built.foundation.id);
    // The key derives from `provenance.originInstanceId`, a SENDER-written field a forger can
    // re-fingerprint for free, which `verifyFoundationCandidate()` cannot see (#7631). Refuse a
    // copy from a different peer than the one already holding that key; no shipped install
    // re-shares inherited records, so a genuine record there came from the origin itself.
    // Re-offering from the same peer stays an ordinary update.
    const held = foundations[key];
    if (held?.inheritance && held.inheritance.sourceInstanceId !== sourceInstanceId) {
      console.warn(`⚠️ Eidoverse foundation "${built.foundation.id}" attributed to origin ${originInstanceId} is already held from peer ${held.inheritance.sourceInstanceId} — refusing the copy offered by peer ${sourceInstanceId} rather than overwriting it`);
      return {
        outcome: 'refused',
        foundation: null,
        reasons: [`this install already holds "${built.foundation.id}" from origin ${originInstanceId} by way of peer ${held.inheritance.sourceInstanceId}; peer ${sourceInstanceId} offered a different copy under that same origin — refusing rather than overwriting the record already attributed to it`],
        findings: [],
      };
    }
    foundations[key] = built.foundation;
    await writeLedger({ foundations, tombstones });
    return { outcome: 'inherited', foundation: { ...built.foundation, lineage: foundationLineage(built.foundation) }, reasons: [], findings: [] };
  });
}

/**
 * Withdraw a foundation this install PROMOTED, retracting it from the shared
 * population (#7632).
 *
 *  1. The record drops back to `vernacular` with `promotedAt` and `candidate`
 *     cleared, leaving the offering immediately.
 *  2. The candidate's fingerprint is TOMBSTONED and rides the offering: the sweep
 *     only converges upward, so without it peers keep their `baseline` copy.
 *
 * The body is KEPT; deleting local work is `deleteEidoverseFoundation()`.
 * A peer predating the tombstone key keeps its copy (best-effort retraction).
 *
 * @returns {Promise<{ outcome: 'withdrawn'|'not-promoted'|'refused'|'unknown-foundation', foundation: object|null, reasons: string[] }>}
 */
export async function withdrawEidoverseFoundation(id, { now = new Date().toISOString() } = {}) {
  return withLedgerLock(async () => {
    const { foundations, tombstones } = await readLedger();
    const current = foundations[id];
    if (!current) return { outcome: 'unknown-foundation', foundation: null, reasons: [`no foundation is recorded under "${id}"`] };
    if (current.inheritance) {
      return {
        outcome: 'refused',
        foundation: null,
        reasons: [`"${id}" is a local copy of a foundation install ${current.inheritance.originInstanceId} promoted — this install never published it, so it has nothing to withdraw (delete the copy instead)`],
      };
    }
    if (current.layer !== 'baseline') {
      return { outcome: 'not-promoted', foundation: { ...current, lineage: foundationLineage(current) }, reasons: [`"${id}" is not promoted, so there is nothing to retract`] };
    }
    // `updatedAt` tracks the body's authorship; withdrawal changes what is published, not what was written.
    const foundation = { ...current, layer: 'vernacular', candidate: null, promotedAt: null };
    foundations[id] = foundation;
    await writeLedger({ foundations, tombstones: tombstoneForReplacedCandidate(tombstones, current, now) });
    console.log(`🚫 Withdrew Eidoverse foundation "${current.title}" from this install's promoted population — peers drop their copy on the next sweep`);
    return { outcome: 'withdrawn', foundation: { ...foundation, lineage: foundationLineage(foundation) }, reasons: [] };
  });
}

/**
 * The retractions advertised beside the offering (`buildEidoverseFoundationOffering()`).
 * The WHOLE capped list, not a delta: receivers have no cursor, and a tombstone
 * for an unheld fingerprint is a no-op.
 */
export async function listWithdrawnFoundationTombstones() {
  return (await readLedger()).tombstones;
}

/**
 * Apply a peer's retractions: drop every local copy inherited FROM that peer
 * whose fingerprint it tombstoned (#7632); the receiving half of
 * `withdrawEidoverseFoundation()`.
 *
 * **Scoped to the sending peer** (`inheritance.sourceInstanceId`): fingerprints
 * are public in the federation, so they are identifiers, not credentials. A
 * tombstone for an unheld fingerprint is a no-op.
 *
 * The peer's tombstones are NOT persisted: this install never re-offers an
 * inherited record, and storing them would let a peer push out this install's own.
 *
 * @returns {Promise<{ removed: number }>}
 */
export async function applyEidoverseFoundationTombstones(peerTombstones, { sourceInstanceId } = {}) {
  const incoming = normalizeTombstones(peerTombstones, TOMBSTONE_KEY_FIELD);
  if (incoming.length === 0 || !sourceInstanceId) return { removed: 0 };
  return withLedgerLock(async () => {
    const { foundations, tombstones } = await readLedger();
    const doomed = Object.entries(foundations).filter(([, entry]) => entry?.inheritance
      && entry.inheritance.sourceInstanceId === sourceInstanceId
      && tombstoneTimestamp(incoming, entry.inheritance.fingerprint, TOMBSTONE_KEY_FIELD) !== null);
    if (doomed.length === 0) return { removed: 0 };
    for (const [key, entry] of doomed) {
      delete foundations[key];
      console.log(`🗑️ Dropped inherited Eidoverse foundation "${entry.title}" — install ${entry.inheritance.originInstanceId} withdrew it`);
    }
    await writeLedger({ foundations, tombstones });
    return { removed: doomed.length };
  });
}

/**
 * Delete a foundation record outright — local work or an inherited copy, the
 * latter addressed as `{ id, originInstanceId }` so the `peer:` key grammar
 * stays private to this module.
 *
 * **Deleting a PROMOTED local record withdraws it first**, or peers' copies
 * would be orphaned permanently.
 *
 * @returns {Promise<{ outcome: 'deleted'|'unknown-foundation', foundation: object|null, withdrawn: boolean }>}
 */
export async function deleteEidoverseFoundation(id, { originInstanceId = null, now = new Date().toISOString() } = {}) {
  return withLedgerLock(async () => {
    const { foundations, tombstones } = await readLedger();
    const key = originInstanceId ? inheritedFoundationStorageKey(originInstanceId, id) : id;
    const current = foundations[key];
    if (!current) return { outcome: 'unknown-foundation', foundation: null, withdrawn: false };
    const withdrawn = wasPublished(current);
    delete foundations[key];
    await writeLedger({ foundations, tombstones: tombstoneForReplacedCandidate(tombstones, current, now) });
    console.log(`🗑️ Deleted Eidoverse foundation "${current.title}"${withdrawn ? ' and withdrew it from the peer offering' : ''}`);
    return { outcome: 'deleted', foundation: current, withdrawn };
  });
}
