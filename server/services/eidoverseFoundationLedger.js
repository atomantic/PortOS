/**
 * The install-local ledger of Eidoverse world foundations — which durable
 * artifacts this instance authored, which ownership layer each one sits in, and
 * the last promote candidate packaged from it (#7455, epic #7453).
 *
 * `server/lib/eidoverseFoundations.js` owns the ownership model and the
 * packaging/validation gate; this module is the persistence, clock, and
 * assay-execution shell around it. Everything authored here lands at the
 * `vernacular` layer, so an artifact is local until somebody promotes it on
 * purpose.
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
 * install is a packaged candidate envelope, and even that leaves only through
 * an explicit promote. There is no `data.reference/` seed — an absent file is
 * an empty ledger, which is the correct state for every install that has never
 * authored a foundation, so no migration is owed.
 */

import { join } from 'node:path';
import { PATHS, atomicWrite, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { getPortosVersion } from '../lib/schemaVersions.js';
import {
  DEFAULT_EIDOVERSE_FOUNDATION_LAYER,
  EIDOVERSE_FOUNDATION_LEDGER_SCHEMA_VERSION,
  assayEvidenceFromVerdict,
  eidoverseFoundationInputSchema,
  packageFoundationCandidate,
} from '../lib/eidoverseFoundations.js';
import { RESILIENCE_DISTURBANCES, runResilienceAssay } from './eidoverseResilienceAssay.js';
import { findContributionById } from './eidoverseResilienceContributions.js';

// Resolved per call rather than captured at module load: `PATHS.data` is what
// a suite re-roots to a temp directory, and a path frozen at import time would
// point every test at the live install's own ledger.
const ledgerDir = () => join(PATHS.data, 'eidoverse');
const ledgerFile = () => join(ledgerDir(), 'foundations.json');

const withLedgerLock = createMutex();

/**
 * Strict read: a `foundations.json` this process cannot parse must NOT read as
 * "no foundations yet", because the very next write would then replace the
 * user's ledger with an empty one. `strict: true` throws on unreadable bytes,
 * while a genuinely ABSENT file still reads as the empty ledger it is.
 */
async function readLedger() {
  const raw = await readJSONFile(ledgerFile(), null, { allowArray: false, strict: true });
  const foundations = raw && typeof raw === 'object' && raw.foundations && typeof raw.foundations === 'object' ? { ...raw.foundations } : {};
  return { schemaVersion: EIDOVERSE_FOUNDATION_LEDGER_SCHEMA_VERSION, foundations };
}

async function writeLedger(ledger) {
  await ensureDir(ledgerDir());
  await atomicWrite(ledgerFile(), { ...ledger, schemaVersion: EIDOVERSE_FOUNDATION_LEDGER_SCHEMA_VERSION });
}

/** Every foundation this install knows about, most recently updated first. */
export async function listEidoverseFoundations() {
  const ledger = await readLedger();
  const foundations = Object.values(ledger.foundations)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return {
    schemaVersion: EIDOVERSE_FOUNDATION_LEDGER_SCHEMA_VERSION,
    counts: {
      vernacular: foundations.filter((entry) => entry.layer === DEFAULT_EIDOVERSE_FOUNDATION_LAYER).length,
      baseline: foundations.filter((entry) => entry.layer === 'baseline').length,
      candidates: foundations.filter((entry) => Boolean(entry.candidate)).length,
    },
    foundations,
  };
}

export async function getEidoverseFoundation(id) {
  const ledger = await readLedger();
  return ledger.foundations[id] || null;
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
 */
export async function recordEidoverseFoundation(input, { originInstanceId, now = new Date().toISOString() } = {}) {
  const authored = eidoverseFoundationInputSchema.parse(input);
  return withLedgerLock(async () => {
    const ledger = await readLedger();
    const existing = ledger.foundations[authored.id] || null;
    const record = {
      id: authored.id,
      layer: existing?.layer === 'baseline' ? 'baseline' : DEFAULT_EIDOVERSE_FOUNDATION_LAYER,
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
      promotedAt: existing?.promotedAt ?? null,
      updatedAt: now,
    };
    ledger.foundations[authored.id] = record;
    await writeLedger(ledger);
    return record;
  });
}

/**
 * Run the agent-free assay against a recorded foundation and, if it and every
 * other gate pass, package the promote candidate onto its record.
 *
 * A refusal is a RESULT, not an exception: "this build is not ready to leave
 * the install" is ordinary, expected output the caller shows the author with
 * its reasons. The assay verdict is persisted either way — a failing verdict is
 * the diagnostic that says what to fix — while the candidate is written only on
 * a pass.
 *
 * @returns {Promise<{ outcome: 'packaged'|'refused'|'unknown-foundation', candidate: object|null, assay: object|null, reasons: string[], findings: Array }>}
 */
export async function packageEidoverseFoundationCandidate(id, { now = new Date().toISOString() } = {}) {
  const portosVersion = await getPortosVersion();
  const existing = await getEidoverseFoundation(id);
  if (!existing) return { outcome: 'unknown-foundation', candidate: null, assay: null, reasons: [`no foundation is recorded under "${id}"`], findings: [] };

  // Outside the ledger lock: replaying a contribution is the slow part, and it
  // reads nothing from the ledger. The lock below re-reads the record and
  // re-checks that the body has not been re-authored underneath the verdict.
  const contribution = await findContributionById(existing.contributionId);
  if (!contribution) {
    return {
      outcome: 'refused',
      candidate: null,
      assay: null,
      reasons: [`no resilience-assay contribution is registered under "${existing.contributionId}" — a foundation is promotable only once it can be replayed without its author`],
      findings: [],
    };
  }
  const assay = assayEvidenceFromVerdict(runResilienceAssay(contribution), { ranAt: now });

  return withLedgerLock(async () => {
    const ledger = await readLedger();
    const current = ledger.foundations[id];
    if (!current) return { outcome: 'unknown-foundation', candidate: null, assay: null, reasons: [`no foundation is recorded under "${id}"`], findings: [] };
    if (current.updatedAt !== existing.updatedAt) {
      return { outcome: 'refused', candidate: null, assay: null, reasons: ['the foundation was re-authored while the assay was running — package it again'], findings: [] };
    }

    const result = packageFoundationCandidate({
      record: { ...current, assay, candidate: null },
      requiredDisturbances: RESILIENCE_DISTURBANCES,
      portosVersion,
      now,
    });
    ledger.foundations[id] = { ...current, assay, candidate: result.candidate, updatedAt: now };
    await writeLedger(ledger);
    return { ...result, assay };
  });
}
