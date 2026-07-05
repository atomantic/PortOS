/**
 * Pipeline — Reader panel (#2170, CWQE Phase 6).
 *
 * Four reader personas each read a condensed arc digest of a series (see
 * readerPanelDigest.js) and answer the same ~10 qualitative questions, citing
 * issue numbers. The editorial value is the DISAGREEMENT between them: issues
 * flagged by some-but-not-all personas are surfaced for the human as judgment
 * calls; issues with ≥3-persona consensus are routed into the normal
 * manuscript-review triage flow via `seedReviewFromFindings`.
 *
 * One LLM call per persona, run only from an explicit user action (the panel
 * "Convene" button) or an autopilot step — never at boot (AI-provider policy).
 * The snapshot persists at `data/pipeline-reader-panel/{seriesId}.json` and pins
 * the digest's `sourceContentHash` so the UI can flag a stale panel after edits.
 *
 * The batch lifecycle (per-persona SSE progress) lives in readerPanelRunner.js;
 * pure mining lives in server/lib/editorial/panelDisagreement.js. Errors bubble
 * (no try/catch) — the runner owns the boundary.
 */

import { join } from 'path';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../../lib/fileUtils.js';
import { runStagedLLM } from '../../lib/stageRunner.js';
import {
  PANEL_PERSONA_IDS,
  minePanelDisagreements,
  consensusToFindings,
  sanitizePersonaResponse,
} from '../../lib/editorial/panelDisagreement.js';
import { computeSourceContentHash, renderDigestText } from './readerPanelDigest.js';
import { seedReviewFromFindings } from './manuscriptReview.js';

const CONSENSUS_CHECK_ID = 'reader-panel.consensus';
const nowIso = () => new Date().toISOString();

// Series ids are `ser-<uuid>` — restrict to a safe charset before interpolating
// into the on-disk snapshot path (defense-in-depth against path traversal).
function assertValidSeriesId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid series id: ${id}`);
  }
}

const panelDir = () => join(PATHS.data, 'pipeline-reader-panel');
const snapshotPath = (seriesId) => join(panelDir(), `${seriesId}.json`);

async function loadSnapshot(seriesId) {
  const content = await tryReadFile(snapshotPath(seriesId));
  if (content === null) return null;
  return safeJSONParse(content, null, { allowArray: false, logError: true, context: snapshotPath(seriesId) });
}

async function saveSnapshot(snapshot) {
  await ensureDir(panelDir());
  await atomicWrite(snapshotPath(snapshot.seriesId), snapshot);
}

const personaStage = (personaId) => `pipeline-panel-${personaId}`;

// Shared variables every persona prompt reads — the rendered digest + series meta.
function digestVariables(digest) {
  return {
    seriesName: digest.seriesName,
    logline: digest.logline || '',
    issueCount: digest.issueCount,
    digest: renderDigestText(digest),
  };
}

/**
 * Run ONE persona over the digest. Returns the sanitized response
 * `{ persona, answers, verdict }` plus provider/model/runId provenance. The
 * `validIssueNumbers` from the digest clamp cited numbers to real issues.
 */
export async function runPersona(personaId, digest, { providerId, model } = {}) {
  if (!PANEL_PERSONA_IDS.includes(personaId)) throw new Error(`Unknown reader-panel persona: ${personaId}`);
  const result = await runStagedLLM(personaStage(personaId), digestVariables(digest), {
    returnsJson: true,
    providerOverride: providerId,
    modelOverride: model,
    source: `reader-panel:${personaId}`,
  });
  const response = sanitizePersonaResponse(personaId, result.content, { validIssueNumbers: digest.issueNumbers });
  return { ...response, providerId: result.providerId, model: result.model, runId: result.runId, completedAt: nowIso() };
}

/**
 * Finalize a panel: mine cross-persona disagreement, route ≥3-persona consensus
 * concerns into manuscript-review findings, persist the snapshot, and return it.
 * `mode: 'fresh'` scoped to the reader-panel check id reconciles a re-run's
 * findings (a consensus that's no longer surfaced is auto-dismissed).
 */
export async function finalizePanel(seriesId, digest, responses, { runId = null } = {}) {
  const disagreements = minePanelDisagreements(responses, { validIssueNumbers: digest.issueNumbers });
  const findings = consensusToFindings(disagreements.consensus, responses, {
    checkId: CONSENSUS_CHECK_ID,
    totalPersonas: disagreements.totalPersonas,
  });

  let seededFindings = 0;
  if (responses.length) {
    // Even with zero findings, run in 'fresh' mode so a re-run that resolved a
    // prior consensus auto-dismisses that stale finding. (`findings` derives from
    // `responses`, so a non-empty `findings` already implies a non-empty panel.)
    await seedReviewFromFindings(seriesId, findings, {
      runId,
      mode: 'fresh',
      checkId: CONSENSUS_CHECK_ID,
    });
    seededFindings = findings.length;
  }

  const snapshot = {
    seriesId,
    status: 'complete',
    sourceContentHash: digest.sourceContentHash,
    digestGeneratedAt: digest.generatedAt,
    issueCount: digest.issueCount,
    personas: responses,
    disagreements,
    seededFindings,
    checkId: CONSENSUS_CHECK_ID,
    runId,
    createdAt: nowIso(),
    completedAt: nowIso(),
  };
  await saveSnapshot(snapshot);
  console.log(`🪞 reader panel: series=${seriesId.slice(0, 12)} personas=${responses.length} consensus=${disagreements.consensus.length} attention=${disagreements.attention.length} seeded=${seededFindings}`);
  return snapshot;
}

// Re-hash the current issue content to decide whether a stored panel is stale
// (the drafts moved since the digest was built). Cheap — issue list + content
// only, no series record or scene segmentation (the hash ignores both).
async function isPanelStale(snapshot, seriesId) {
  if (!snapshot || snapshot.status !== 'complete' || !snapshot.sourceContentHash) return false;
  const hash = await computeSourceContentHash(seriesId).catch(() => null);
  if (hash === null) return false;
  return hash !== snapshot.sourceContentHash;
}

/**
 * Load the stored panel with a `stale` flag. Returns `{ status: 'none' }` when
 * the panel has never been convened.
 */
export async function getReaderPanel(seriesId) {
  assertValidSeriesId(seriesId);
  const snapshot = await loadSnapshot(seriesId);
  if (!snapshot) return { seriesId, status: 'none', personas: [], disagreements: null };
  return { ...snapshot, stale: await isPanelStale(snapshot, seriesId) };
}
