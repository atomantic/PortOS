/**
 * The install-local ledger of Eidoverse world foundations — which durable
 * artifacts this instance authored or inherited, which ownership layer each
 * one sits in, and the last promote candidate packaged from (or inheritance
 * edge built for) it (#7455, #7461, epic #7453).
 *
 * `server/lib/eidoverseFoundations.js` owns the ownership model and the
 * packaging/validation gate; this module is the persistence, clock, and
 * assay-execution shell around it. Everything AUTHORED here lands at the
 * `vernacular` layer, so an artifact is local until somebody promotes it on
 * purpose. The one other way a record enters this ledger is as a local copy
 * of a foundation a PEER promoted — `recordEidoverseFoundationInheritance()` —
 * which lands directly at `baseline` and carries an `inherited-from` edge
 * rather than this install's own authorship.
 *
 * Between the two sits DERIVATION (#7631): a record this install authored by
 * building on an inherited copy. It is local work — it packages and promotes
 * like any other — but it carries, and publishes, a `derived-from` edge back to
 * the origin. `recordEidoverseFoundation()` refuses a body that matches an
 * inherited one and names no such edge, which is what closed the path from
 * 'load a peer's foundation into the authoring form' to 're-share it as this
 * install's own work'.
 *
 * **The promote gate runs the agent-free assay; it never accepts a verdict.**
 * `packageEidoverseFoundationCandidate()` DERIVES the sandbox from the
 * foundation's own body (`lib/eidoverseFoundationSandbox.js`, #7625), replays it
 * through `runResilienceAssay()` (#7460), and packages against the verdict it
 * just produced. Deriving rather than resolving a caller-supplied
 * `contributionId` is what makes 'what was evaluated' and 'what gets promoted'
 * the same object: the id used to be free text, so a local build could name a
 * shipped demo fixture and promote on evidence about the fixture.
 *
 * A caller — a route, a mind tool — therefore cannot assert that
 * its build survived its author's absence; it can only ask for the check. That
 * is the same proposal-versus-consequence separation #7454 gave the
 * construction tools, applied to promotion.
 *
 * Storage is `data/eidoverse/foundations.json` — `file-primary` and MACHINE
 * LOCAL, the same class as `portos-world.json` beside it (`docs/STORAGE.md`).
 * PortOS never federates this file: the only thing authorized to leave the
 * install is a packaged candidate envelope, and even that leaves only once
 * somebody promotes the foundation — `listPromotedFoundationCandidates()`
 * below is the whole of what a peer can ever read
 * (`services/sharing/peerEidoverseFoundationSync.js`). There is no `data.reference/` seed — an absent file is
 * an empty ledger, which is the correct state for every install that has never
 * authored or inherited a foundation, so no migration is owed.
 *
 * **Withdrawal is a first-class act, and it propagates (#7632).** Promotion used
 * to be one-way: a peer that pulled a foundation kept that copy forever, because
 * the offering only ever ADDED and the sweep converged upward toward the
 * sender's list. Re-authoring already de-promoted a record locally, which
 * silently dropped it from the offering and left every receiver holding a
 * `baseline` copy of bytes the author had retracted. `withdrawEidoverseFoundation()`
 * below makes that retraction explicit and records a TOMBSTONE — keyed on the
 * candidate's content-addressed fingerprint, the one identifier that means the
 * same thing on every install — which rides the offering beside the candidates
 * so a receiver DROPS the copy instead of merely ceasing to re-pull it.
 * `applyEidoverseFoundationTombstones()` is that receiving half.
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
 * Storage-layout version stamped on `data/eidoverse/foundations.json`.
 *
 * Still 1 with the `tombstones` list added (#7632): the key is ADDITIVE and
 * compatible in both directions — a PortOS that predates it ignores the key,
 * and this one reads a file without it as an empty tombstone list, which is
 * exactly right for an install that has never withdrawn anything. Bumping
 * would advertise an incompatibility that does not exist. The one asymmetry
 * worth naming: an older PortOS that WRITES this file back drops the
 * tombstones, so a downgrade-then-upgrade loses pending retractions that had
 * not yet reached a peer. That is a lost withdrawal, not a corrupted ledger,
 * and re-withdrawing the record records it again.
 */
const LEDGER_SCHEMA_VERSION = 1;

/**
 * Tombstones are keyed on the promote candidate's `fingerprint`, NOT on the
 * foundation id. The id is local and two installs can legitimately carry the
 * same one; the fingerprint is a sha256 over the canonicalized envelope, so it
 * names one specific published body and means the same thing everywhere. It is
 * also exactly what the receiver already stores on its inherited copy
 * (`inheritance.fingerprint`), so a match needs no extra index.
 */
const TOMBSTONE_KEY_FIELD = 'fingerprint';

/**
 * Capped independently of `OFFERING_ENTRY_CAP` in the transport, and far above
 * any realistic withdrawal history. A retraction must never be displaced to
 * make room for a publication — the whole point is that it outranks one.
 */
const TOMBSTONE_LIMIT = 200;

const tombstoneOptions = { keyField: TOMBSTONE_KEY_FIELD, limit: TOMBSTONE_LIMIT };

// Read through `PATHS` per call, NOT `dataPath()`: a suite redirects the data
// root by proxying this module's `fileUtils` import, and `dataPath()` resolves
// against `paths.js`'s own `PATHS` binding, which that proxy never sees — so
// the helper would send every test at the live install's ledger. Per call
// rather than captured at module load for the same reason.
const ledgerFile = () => join(PATHS.data, 'eidoverse', 'foundations.json');

const withLedgerLock = createMutex();

/**
 * Strict read: a `foundations.json` this process cannot parse must NOT read as
 * "no foundations yet", because the very next write would then replace the
 * user's ledger with an empty one. `strict: true` throws on unreadable bytes,
 * while a genuinely ABSENT file still reads as the empty ledger it is.
 */
async function readLedger() {
  const raw = await readJSONFile(ledgerFile(), null, { allowArray: false, strict: true });
  const stored = raw && typeof raw === 'object' ? raw : {};
  return {
    foundations: stored.foundations && typeof stored.foundations === 'object' ? { ...stored.foundations } : {},
    // Normalized on READ as well as write: this list is the one part of the
    // ledger a peer's offering also writes, and `foundations.json` is a file a
    // human can edit. An entry without a usable key or stamp could never win a
    // comparison anyway, so dropping it here keeps every downstream reader from
    // having to re-check the shape.
    tombstones: normalizeTombstones(stored.tombstones, TOMBSTONE_KEY_FIELD),
  };
}

/** The foundations map alone, for the read-only paths that never write back. */
const readFoundations = async () => (await readLedger()).foundations;

// Both halves always written together: a `writeFoundations(foundations)` that
// defaulted the tombstones would erase every pending retraction on the next
// ordinary authoring write, which is precisely the silent-loss shape #7632
// exists to close.
async function writeLedger({ foundations, tombstones }) {
  await atomicWrite(ledgerFile(), {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    foundations,
    tombstones: normalizeTombstones(tombstones, TOMBSTONE_KEY_FIELD),
  });
}

/**
 * Every foundation this install knows about, most recently updated first —
 * both what this install authored and any local copy it holds of a peer's
 * promoted foundation (#7461). Each entry carries its derived `lineage`
 * (proposal → commit → promote/inherit), computed fresh on every read rather
 * than stored, per `foundationLineage()`'s own header.
 */
export async function listEidoverseFoundations() {
  const foundations = Object.values(await readFoundations())
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const counts = foundations.reduce((totals, entry) => ({
    vernacular: totals.vernacular + (entry.layer === 'vernacular' ? 1 : 0),
    baseline: totals.baseline + (entry.layer === 'baseline' ? 1 : 0),
    candidates: totals.candidates + (entry.candidate ? 1 : 0),
    // A subset of `baseline`: this install pulled the copy from a peer rather
    // than promoting its own work into it.
    inherited: totals.inherited + (entry.inheritance ? 1 : 0),
  }), { vernacular: 0, baseline: 0, candidates: 0, inherited: 0 });
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    counts,
    foundations: foundations.map((entry) => ({ ...entry, lineage: foundationLineage(entry) })),
  };
}

/**
 * The promote envelopes this install OFFERS to its federated peers (#7455) —
 * the read behind `GET /api/peer-sync/eidoverse-foundations`.
 *
 * Three filters, each load-bearing:
 *
 *  - `layer === 'baseline'` — only what somebody deliberately promoted. A
 *    `vernacular` record may carry a packaged candidate (packaging is the step
 *    BEFORE promoting); packaging is "show me whether this would pass", not
 *    "publish this", and serving those would turn a dry run into a broadcast.
 *  - `!inheritance` — `baseline` covers BOTH what this install promoted and a
 *    local copy of a peer's, so offering every `baseline` record would re-share
 *    another install's work. That matches `packageEidoverseFoundationCandidate`,
 *    which already refuses an inherited record ("promotion re-shares only
 *    foundations this install authored"): a peer that wants a third install's
 *    foundation pulls it from the install that authored it.
 *  - the candidate still VERIFIES — the envelope was gated when it was
 *    promoted, but `foundations.json` is a file a human can edit and a partial
 *    hand-edit is exactly how a machine name or a local path would end up
 *    inside a body that was clean when it was packaged. Refuse-never-redact
 *    applies outbound as well as inbound, so a candidate that no longer passes
 *    is dropped from the offering (and logged) rather than served.
 *
 * Returns the envelopes only — never the ledger records, which carry the
 * `style` layer that is not authorized to leave this install.
 */
export async function listPromotedFoundationCandidates() {
  const { foundations, tombstones } = await readLedger();
  const offerable = Object.values(foundations)
    .filter((entry) => entry?.layer === 'baseline' && !entry.inheritance && entry.candidate);
  const candidates = [];
  for (const entry of offerable) {
    // A fourth filter (#7632), and a backstop rather than a live path: promoting
    // clears the fingerprint's tombstone, so the two lists cannot normally
    // disagree. A hand-edited ledger can make them disagree, and an offering
    // that both published and retracted one fingerprint would resolve
    // differently on every receiver depending on which list it applied first.
    // The retraction wins, because refuse-never-redact runs outbound too.
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
 * One foundation by REFERENCE — `{ id, originInstanceId }` — which is the only
 * way an inherited copy of a peer's foundation is addressable (#7626).
 *
 * `getEidoverseFoundation(id)` above reaches exactly the records this install
 * AUTHORED, because a plain id is the ledger key for those and only those. A
 * local copy of a peer's foundation lives under
 * `inheritedFoundationStorageKey()`'s disjoint `peer:` namespace, so until
 * this existed every read-one caller — the HTTP route, and therefore every
 * mind surface built on it — could reach a local record and nothing else. The
 * list endpoint returned whole records, so a HUMAN could read an inherited
 * body in the panel while a Mind on the same install could not obtain it at
 * all.
 *
 * Deliberately NOT a widening of the id: `originInstanceId` is its own field,
 * and `null` means "the record authored here", never "whichever matches".
 */
export async function getEidoverseFoundationByRef(ref) {
  return getEidoverseFoundation(foundationLedgerKey(ref));
}

/**
 * ADOPT a foundation this install inherited from a peer — stand its `body` up
 * as something that actually runs here, carrying a `derived-from` edge back to
 * the origin (#7626).
 *
 * This is the verb epic #7453's success signal ("a mind uses what another mind
 * left") always needed and never had. Inheriting stored a row: no runtime on
 * either install read a foundation's `body`, so the only way to use a peer's
 * contribution was a human reading raw JSON out of the Foundations panel and
 * retyping it — which is precisely the "go read the author's transcript" path
 * the epic set out to replace, and which keeps no attribution at all.
 *
 * What adoption does is decided per KIND by `planFoundationAdoption()`, and a
 * kind with no interpreter here is REFUSED BY NAME rather than silently
 * "adopted" into nothing. Only `controller` is adoptable today, and even then
 * the peer names WHICH SHIPPED CONTROLLER to run, never code: `definitionId` is
 * resolved against this install's own fixed registry by
 * `installEidoverseController()`, so adopting can never execute a peer's
 * bytes. The install lands DISARMED with `deliverEffects: false` — arming a
 * peer's controller and letting it speak in the world stay separate, local
 * decisions.
 *
 * A refusal is a RESULT with its reasons, the shape every other gate in this
 * module uses.
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

  // The install id is the foundation's own id, so re-adopting the same
  // foundation updates one install instead of accumulating copies. That makes
  // it possible for the id to name a controller this install already stood up
  // for some OTHER reason, and installing over it would silently retarget a
  // running controller at a peer's config. Refuse that by name; only an
  // install already derived from this same foundation is re-adoptable.
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
 * A `district-template` foundation's `body.placement` is DERIVED, never
 * trusted verbatim from the caller (#7627): `generateDistrictTemplatePlacement()`
 * is deterministic and seeded, so replaying `{layoutId, anchor, seed}` here —
 * the same replay a peer runs on inherit — is what makes the module's "same
 * inputs reproduce the same geometry" claim actually hold on the install that
 * authored it. A caller-supplied `placement` that disagrees with the
 * derivation is REPLACED wholesale, not merged: a stale or hand-edited value
 * must never ride along looking like the derivation's own output.
 *
 * A body missing `layoutId` or `anchor` (an older shape, or a foundation kind
 * this doesn't apply to) is returned unchanged — this only expands the one
 * documented generative shape, never invents one.
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
 * `originInstanceId` is supplied by the caller rather than read here so this
 * module stays a single-purpose store; `getInstanceId()` from
 * `services/instanceIdentity.js` is what every caller passes.
 *
 * Re-authoring an existing id keeps its original `createdAt` and origin — an
 * artifact's provenance is part of its identity — and CLEARS the packaged
 * candidate and the recorded assay, because both described the previous body.
 * Carrying a passing verdict across an edit is exactly the "it worked when I
 * narrated it" claim the agent-free harness exists to refuse.
 *
 * For the same reason a re-authored `baseline` foundation drops back to
 * `vernacular` with `promotedAt` cleared: the body that was promoted no longer
 * exists on this install, so a record still claiming to be part of the shared
 * baseline would be describing bytes nobody has. It is local work again until
 * somebody promotes the new body. (Keeping the `baseline` stamp instead would
 * also be a dead end — `layerPromoteRefusal` refuses to package a `baseline`
 * foundation, so the edit could never be published.)
 */
export async function recordEidoverseFoundation(input, { originInstanceId, now = new Date().toISOString() } = {}) {
  const authored = eidoverseFoundationInputSchema.parse(input);
  return withLedgerLock(async () => {
    const { foundations, tombstones } = await readLedger();
    const existing = foundations[authored.id] || null;
    // The republish guard (#7631). `inheritance` below is a field THIS path
    // clears, so it could never have stopped a peer's foundation being saved
    // back through the authoring surface and promoted as local work; the body
    // itself is what gets checked, against every inherited copy this install
    // holds. A refusal is thrown rather than returned because both callers —
    // the route and the mind tool — treat this function's return value as the
    // recorded foundation, and a verdict shape would make "refused" look like
    // a saved record to anything that did not read the new field.
    // Digest the body as it will be STORED, not as it arrived (#7627 + #7631).
    // A district-template's `placement` is derived here rather than supplied, so
    // a caller who re-submits only the `{layoutId, anchor, seed}` recipe of an
    // inherited template — which is exactly what `eidoverse.draft-foundation`
    // hands back — would otherwise digest a body the inherited copy never had,
    // slip past the republish guard, and then be stored byte-identical to it.
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
      // DERIVED, never authored (#7625): the assay replays this foundation's
      // own body, so the label that binds evidence to it is computed from that
      // body — the STORED one derived just above, which is what the sandbox
      // will actually replay. A caller that could name the label could point
      // the gate at a shipped demo fixture and inherit its passing verdict.
      contributionId: derivedContributionId({ kind: authored.kind, id: authored.id, body }),
      body,
      style: authored.style,
      provenance: existing?.provenance || { originInstanceId, authorKind: authored.authorKind, createdAt: now },
      disclosure: authored.disclosure,
      assay: null,
      candidate: null,
      promotedAt: null,
      // Always `null` here: this path authors LOCAL work. A ledger key this
      // function writes is always the plain id, never
      // `inheritedFoundationStorageKey()`'s namespace, so it can never
      // overwrite (or be confused with) a copy pulled from a peer.
      inheritance: null,
      derivedFrom: derivation.edge,
      updatedAt: now,
    };
    foundations[authored.id] = record;
    // Re-authoring a PROMOTED foundation is a retraction of the published body,
    // and it is the one the issue that prompted #7632 opens with: the record
    // silently dropped back to `vernacular`, left the offering, and every peer
    // that had pulled it kept a `baseline` copy of bytes this install no longer
    // has. The candidate being replaced is what those peers hold, so tombstone
    // its fingerprint — the new body publishes under a new one when (and if)
    // somebody promotes it.
    await writeLedger({ foundations, tombstones: tombstoneForReplacedCandidate(tombstones, existing, now) });
    return record;
  });
}

/**
 * Tombstone the candidate a write is about to replace, but ONLY when that
 * candidate was actually published. A merely PACKAGED candidate on a
 * `vernacular` record never left the install — `listPromotedFoundationCandidates()`
 * refuses to serve one — so tombstoning it would broadcast a retraction for a
 * fingerprint no peer could ever hold, burning a tombstone slot for nothing.
 */
const wasPublished = (entry) => entry?.layer === 'baseline' && !entry.inheritance && typeof entry.candidate?.fingerprint === 'string';

function tombstoneForReplacedCandidate(tombstones, existing, now) {
  if (!wasPublished(existing)) return tombstones;
  return recordTombstone(tombstones, existing.candidate.fingerprint, { ...tombstoneOptions, deletedAt: now });
}

const verdict = (outcome, reasons) => ({ outcome, candidate: null, assay: null, reasons, findings: [] });
const unknownFoundation = (id) => verdict('unknown-foundation', [`no foundation is recorded under "${id}"`]);

/**
 * Run the agent-free assay against a recorded foundation and, if it and every
 * other gate pass, package the promote candidate onto its record.
 *
 * A refusal is a RESULT, not an exception: "this build is not ready to leave
 * the install" is ordinary, expected output the caller shows the author with
 * its reasons. The assay verdict is persisted either way — a failing verdict is
 * the diagnostic that says what to fix — while a refusal clears any candidate
 * packaged earlier, since the verdict that vouched for it no longer holds.
 *
 * @returns {Promise<{ outcome: 'packaged'|'refused'|'unknown-foundation', candidate: object|null, assay: object|null, reasons: string[], findings: Array }>}
 */
export async function packageEidoverseFoundationCandidate(id, { now = new Date().toISOString() } = {}) {
  const existing = await getEidoverseFoundation(id);
  if (!existing) return unknownFoundation(id);
  // Refused before resolving or replaying ANYTHING: `packageFoundationCandidate`
  // (the pure lib) refuses an inherited record too, but only after running the
  // assay against the body it carries. That body came from a PEER — replaying
  // it here would be exactly the "run arbitrary code pulled from a peer" this
  // install's own assay harness exists to keep off every OTHER install, even
  // though the derivation only ever executes code PortOS itself ships.
  if (existing.inheritance) {
    return verdict('refused', [`inherited from another install (${existing.inheritance.originInstanceId}) — promotion re-shares only foundations this install authored`]);
  }

  // Outside the ledger lock: replaying a contribution is the slow part, and it
  // reads nothing from the ledger. The lock below re-reads the record and
  // re-checks that the body has not been re-authored underneath the verdict.
  //
  // The sandbox is derived from THIS FOUNDATION'S OWN BODY (#7625). It used to
  // be resolved by the id the author typed, so the gate replayed whatever
  // module was named and the verdict described that module rather than this
  // build. A body with no derivable sandbox is refused with the reason, which
  // is the honest answer: nothing can replay it without its author.
  const { contribution, refusal } = await foundationSandbox(existing, { findControllerDefinition: findControllerDefinitionById });
  if (refusal) return verdict('refused', [refusal]);
  const assay = assayEvidenceFromVerdict(runResilienceAssay(contribution), { ranAt: now });
  // Read after the early returns: `getPortosVersion()` re-reads and re-parses
  // package.json on every call, and a request naming an id this install never
  // authored should not pay for it.
  const portosVersion = await getPortosVersion();

  return withLedgerLock(async () => {
    const { foundations, tombstones } = await readLedger();
    const current = foundations[id];
    if (!current) return unknownFoundation(id);
    if (current.updatedAt !== existing.updatedAt) {
      return verdict('refused', ['the foundation was re-authored while the assay was running — package it again']);
    }

    // `contributionId` is re-derived here rather than read off the record, so a
    // record written before #7625 (or restored from a backup that predates it)
    // heals on its next package attempt instead of failing the pure gate's
    // binding backstop forever.
    const result = packageFoundationCandidate({
      record: { ...current, contributionId: contribution.id, assay, candidate: null },
      requiredDisturbances: RESILIENCE_DISTURBANCES,
      portosVersion,
      now,
    });
    // `updatedAt` tracks the BODY's authorship, not assay runs: bumping it here
    // would reorder the list on a refusal and make the optimistic check above
    // report a re-authoring that never happened. A refusal also clears any
    // previously packaged candidate — the verdict that vouched for it no
    // longer holds, even though the bytes are unchanged.
    foundations[id] = { ...current, contributionId: contribution.id, assay, candidate: result.candidate };
    await writeLedger({ foundations, tombstones });
    return { ...result, assay };
  });
}

/**
 * Promote a packaged foundation into this install's shared baseline population.
 *
 * Promotion re-packages first and publishes the candidate it just produced, so
 * it can never rest on a stored verdict: every gate — ownership, the agent-free
 * assay, the style-leak scan, federation safety, the content-addressed
 * fingerprint — is re-run against the body as it stands right now. A refusal is
 * a RESULT with its reasons, exactly as packaging is; nothing moves layer.
 *
 * `baseline` means "this install offers this foundation to the shared
 * population", and it is literally the set served from:
 * `listPromotedFoundationCandidates()` reads it for the peer-facing offering
 * at `GET /api/peer-sync/eidoverse-foundations`. The promoted record keeps its
 * `style` locally — only the candidate envelope, which has no style layer at
 * all, is authorized to cross, per the federated Eidoverse foundations ADR
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
    // Packaging released the ledger lock before this one was taken, so an
    // author (or a mind) could have re-authored the body in the gap — which
    // clears the candidate. Publishing then would ship bytes nobody gated.
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
    // Re-publishing a body that was withdrawn earlier clears its tombstone, or
    // the offering would carry a retraction and the republication of the very
    // same fingerprint at once and every receiver would reap what it just
    // inherited, forever. This is `tombstones.js`'s re-create case: the
    // fingerprint is content-addressed, so an identical body promoted again IS
    // the same key, and only an explicit clear can distinguish "I changed my
    // mind" from "I never withdrew it".
    await writeLedger({ foundations, tombstones: clearTombstone(tombstones, packaged.candidate.fingerprint, TOMBSTONE_KEY_FIELD) });
    return { ...packaged, outcome: 'promoted', promoted: true, foundation };
  });
}

/**
 * Accept a promote candidate this install pulled from a peer and store it as
 * a local baseline copy, carrying an `inherited-from` edge back to its origin
 * (#7461).
 *
 * The caller is the pull/inherit transport in
 * `services/sharing/peerEidoverseFoundationSync.js` (#7455), which has fetched
 * the envelope from a full-sync peer and can vouch for `sourceInstanceId` —
 * the peer it pulled FROM, which differs from the candidate's own
 * `originInstanceId` on a foundation re-shared through more than one hop (see
 * `foundationFromInheritedCandidate()`).
 *
 * `localInstanceId` is supplied by the caller rather than read here, matching
 * `recordEidoverseFoundation()`'s own convention: this module stays a
 * single-purpose store, and the future transport already has to resolve its
 * own instance id to make the pull in the first place.
 *
 * Every gate `promoteEidoverseFoundation()` runs on the SENDING side —
 * schema, content-addressed fingerprint, the assay evidence already recorded
 * in the envelope, and federation safety (PII, credentials, machine identity)
 * — runs again here on the RECEIVING side: a payload handed over by a peer is
 * exactly the untrusted input `verifyFoundationCandidate()` exists for. A
 * candidate that fails is refused outright and nothing is written — never
 * stored redacted, and never allowed to shadow (or read as) a local
 * vernacular foundation of the same id, because it is stored under
 * `inheritedFoundationStorageKey()`'s disjoint namespace instead.
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
    // The storage key is chosen by `provenance.originInstanceId` — a field the
    // SENDER wrote and hashed into its own fingerprint, so re-fingerprinting an
    // altered origin costs a forger nothing and `verifyFoundationCandidate()`
    // (which only checks self-consistency) cannot see it. Without this check a
    // peer offering an envelope that claims ANOTHER install's origin silently
    // replaced this install's genuine copy of that install's foundation (#7631).
    //
    // Divergence is the whole signal: `listPromotedFoundationCandidates()`
    // filters out inherited records, so no shipped install re-shares a
    // foundation it did not author, and a genuine record under this key can
    // therefore only ever have come from the origin itself. Re-offering from
    // the SAME peer stays an ordinary update.
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
 * Two things happen, and the second is the one that makes this different from
 * every de-promotion that came before it:
 *
 *  1. The record drops back to `vernacular` with `promotedAt` and `candidate`
 *     cleared — the same transition re-authoring performs. It leaves the
 *     offering immediately, because `listPromotedFoundationCandidates()` serves
 *     `baseline` records only.
 *  2. The withdrawn candidate's fingerprint is TOMBSTONED, and the tombstone
 *     rides the offering. Without it, a peer that already pulled the foundation
 *     keeps its `baseline` copy indefinitely: the sweep converges upward toward
 *     whatever the sender currently lists and has no way to express "and drop
 *     what I no longer list", because a foundation legitimately absent from one
 *     offering is indistinguishable from one the sender never had.
 *
 * The body is KEPT. Withdrawal un-publishes; deleting the local work is
 * `deleteEidoverseFoundation()` and a separate decision.
 *
 * A peer running a version that predates the tombstone key keeps its copy and
 * says so in its log. That is unavoidable by construction — it is why the
 * retraction is documented as best-effort rather than a guarantee — and it is
 * the correct failure mode: it degrades to today's behavior rather than
 * mis-reading a key it does not know.
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
    // `updatedAt` is untouched: it tracks the BODY's authorship, and a
    // withdrawal changes what this install publishes, not what it wrote.
    const foundation = { ...current, layer: 'vernacular', candidate: null, promotedAt: null };
    foundations[id] = foundation;
    await writeLedger({ foundations, tombstones: tombstoneForReplacedCandidate(tombstones, current, now) });
    console.log(`🚫 Withdrew Eidoverse foundation "${current.title}" from this install's promoted population — peers drop their copy on the next sweep`);
    return { outcome: 'withdrawn', foundation: { ...foundation, lineage: foundationLineage(foundation) }, reasons: [] };
  });
}

/**
 * The retractions this install advertises beside its offering — read by
 * `buildEidoverseFoundationOffering()` in the peer transport.
 *
 * Deliberately the WHOLE capped list, not a delta: a receiver that was offline
 * across several withdrawals has no cursor, and a tombstone for a fingerprint
 * nobody holds is a silent no-op on the receiving side, so re-sending one costs
 * nothing but bytes.
 */
export async function listWithdrawnFoundationTombstones() {
  return (await readLedger()).tombstones;
}

/**
 * Apply a peer's retractions: drop every local copy this install inherited FROM
 * that peer whose fingerprint the peer has tombstoned (#7632). The receiving
 * half of `withdrawEidoverseFoundation()`.
 *
 * **Scoped to the peer that sent them.** A tombstone authorizes dropping only a
 * record this install pulled from that same peer (`inheritance.sourceInstanceId`).
 * Otherwise any registered peer could retract a third install's foundation by
 * naming its fingerprint — a fingerprint is public inside the federation the
 * moment it is offered, so it is an identifier, never a credential.
 *
 * A tombstone for a fingerprint this install does not hold is a no-op, not an
 * error: a receiver that never pulled the foundation (or already dropped it) is
 * already in the state the retraction asks for.
 *
 * The peer's tombstones are NOT persisted here. This install never re-offers an
 * inherited record, so it can never relay one; and the sender keeps advertising
 * the tombstone while its candidate stays absent, so there is no window in
 * which a dropped copy could be re-inherited. Storing them would only let a
 * peer grow this install's capped list and push out its own retractions.
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
 * Delete a foundation record outright — local work or an inherited copy.
 *
 * An inherited copy is addressed as `{ id, originInstanceId }` rather than by
 * its raw `peer:<origin>:<id>` storage key, so the ledger's key grammar stays
 * an implementation detail of this module instead of something a caller has to
 * assemble (and could assemble wrong).
 *
 * **Deleting a PROMOTED local record withdraws it first.** Dropping the row
 * without a tombstone would orphan every peer's copy permanently, which is the
 * exact failure withdrawal exists to prevent — and it would be reached by the
 * most natural gesture a regretful author makes ("remove this").
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
