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
 * **The promote gate runs the agent-free assay; it never accepts a verdict.**
 * `packageEidoverseFoundationCandidate()` resolves the foundation's declared
 * contribution by ID through `eidoverseResilienceContributions.js`, replays it
 * through `runResilienceAssay()` (#7460), and packages against the verdict it
 * just produced. A caller — a route, a mind tool — therefore cannot assert that
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
 */

import { join } from 'node:path';
import { PATHS, atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { getPortosVersion } from '../lib/schemaVersions.js';
import {
  DEFAULT_EIDOVERSE_FOUNDATION_LAYER,
  assayEvidenceFromVerdict,
  eidoverseFoundationInputSchema,
  foundationFromInheritedCandidate,
  foundationLineage,
  inheritedFoundationStorageKey,
  packageFoundationCandidate,
  verifyFoundationCandidate,
} from '../lib/eidoverseFoundations.js';
import { RESILIENCE_DISTURBANCES, runResilienceAssay } from './eidoverseResilienceAssay.js';
import { findContributionById } from './eidoverseResilienceContributions.js';

/** Storage-layout version stamped on `data/eidoverse/foundations.json`. */
const LEDGER_SCHEMA_VERSION = 1;

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
async function readFoundations() {
  const raw = await readJSONFile(ledgerFile(), null, { allowArray: false, strict: true });
  return raw && typeof raw === 'object' && raw.foundations && typeof raw.foundations === 'object' ? { ...raw.foundations } : {};
}

async function writeFoundations(foundations) {
  await atomicWrite(ledgerFile(), { schemaVersion: LEDGER_SCHEMA_VERSION, foundations });
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
  const offerable = Object.values(await readFoundations())
    .filter((entry) => entry?.layer === 'baseline' && !entry.inheritance && entry.candidate);
  const candidates = [];
  for (const entry of offerable) {
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
    const foundations = await readFoundations();
    const existing = foundations[authored.id] || null;
    const record = {
      id: authored.id,
      layer: DEFAULT_EIDOVERSE_FOUNDATION_LAYER,
      kind: authored.kind,
      title: authored.title,
      summary: authored.summary,
      contributionId: authored.contributionId,
      body: authored.body,
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
      updatedAt: now,
    };
    foundations[authored.id] = record;
    await writeFoundations(foundations);
    return record;
  });
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
  // assay against whatever `contributionId` it names. This is a local copy of a
  // PEER's declared contribution id — replaying it here would be exactly the
  // "run arbitrary code pulled from a peer" this install's own assay harness
  // exists to keep off every OTHER install, even though `findContributionById`
  // only ever resolves this install's own fixed local registry.
  if (existing.inheritance) {
    return verdict('refused', [`inherited from another install (${existing.inheritance.originInstanceId}) — promotion re-shares only foundations this install authored`]);
  }

  // Outside the ledger lock: replaying a contribution is the slow part, and it
  // reads nothing from the ledger. The lock below re-reads the record and
  // re-checks that the body has not been re-authored underneath the verdict.
  const contribution = await findContributionById(existing.contributionId);
  if (!contribution) {
    return verdict('refused', [`no resilience-assay contribution is registered under "${existing.contributionId}" — a foundation is promotable only once it can be replayed without its author`]);
  }
  const assay = assayEvidenceFromVerdict(runResilienceAssay(contribution), { ranAt: now });
  // Read after the early returns: `getPortosVersion()` re-reads and re-parses
  // package.json on every call, and a request naming an id this install never
  // authored should not pay for it.
  const portosVersion = await getPortosVersion();

  return withLedgerLock(async () => {
    const foundations = await readFoundations();
    const current = foundations[id];
    if (!current) return unknownFoundation(id);
    if (current.updatedAt !== existing.updatedAt) {
      return verdict('refused', ['the foundation was re-authored while the assay was running — package it again']);
    }

    const result = packageFoundationCandidate({
      record: { ...current, assay, candidate: null },
      requiredDisturbances: RESILIENCE_DISTURBANCES,
      portosVersion,
      now,
    });
    // `updatedAt` tracks the BODY's authorship, not assay runs: bumping it here
    // would reorder the list on a refusal and make the optimistic check above
    // report a re-authoring that never happened. A refusal also clears any
    // previously packaged candidate — the verdict that vouched for it no
    // longer holds, even though the bytes are unchanged.
    foundations[id] = { ...current, assay, candidate: result.candidate };
    await writeFoundations(foundations);
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
    const foundations = await readFoundations();
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
    await writeFoundations(foundations);
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
    const foundations = await readFoundations();
    const key = inheritedFoundationStorageKey(built.foundation.provenance.originInstanceId, built.foundation.id);
    foundations[key] = built.foundation;
    await writeFoundations(foundations);
    return { outcome: 'inherited', foundation: { ...built.foundation, lineage: foundationLineage(built.foundation) }, reasons: [], findings: [] };
  });
}
