/**
 * Pipeline — Batch runner for the reader panel (#2170, CWQE Phase 6).
 *
 * Convenes the four-persona panel for a series, streaming per-persona progress
 * to attached SSE clients. Mirrors editorialAnalysisRunner.js: one in-memory
 * `runs` map keyed by `seriesId`, terminal-frame replay for late clients.
 *
 * This is the ONLY entry that spends LLM calls for the panel — it runs only from
 * the explicit `POST /series/:id/editorial/panel/run` action (or an autopilot
 * step), never at boot (AI-provider policy).
 */

import { createSseRunner } from '../../lib/sseUtils.js';
import { PANEL_PERSONAS } from '../../lib/editorial/panelDisagreement.js';
import { buildDigestForSeries } from './readerPanelDigest.js';
import { runPersona, finalizePanel, reconcileConsensusFindings } from './readerPanel.js';

const runner = createSseRunner({ logLabel: 'reader panel' });

export function isReaderPanelActive(seriesId) {
  return runner.isActive(seriesId);
}

export function attachClient(seriesId, res) {
  return runner.attachClient(seriesId, res);
}

export function cancelReaderPanel(seriesId) {
  return runner.cancel(seriesId);
}

/**
 * Kick off the panel run. Returns the runId immediately; per-persona progress
 * lands via SSE. Re-calling while a run is in flight resolves to the existing
 * runId.
 */
export function startReaderPanel(seriesId, options = {}) {
  return runner.start(seriesId, async ({ runId, record, broadcast }) => {
    const digest = await buildDigestForSeries(seriesId);
    if (!digest.issueCount) {
      // No analyzable content — clear any stale consensus findings a prior panel
      // seeded so they don't linger open after the content was removed.
      await reconcileConsensusFindings(seriesId, { runId });
      broadcast({ type: 'complete', runId, personas: 0, empty: true, completedAt: new Date().toISOString() });
      return;
    }

    broadcast({ type: 'start', runId, total: PANEL_PERSONAS.length, issueCount: digest.issueCount });

    const responses = [];
    let done = 0;
    for (const persona of PANEL_PERSONAS) {
      if (record.cancelRequested) break;
      broadcast({ type: 'persona:start', persona: persona.id, label: persona.label, done, total: PANEL_PERSONAS.length });
      const response = await runPersona(persona.id, digest, {
        providerId: options.providerId,
        model: options.model,
      });
      responses.push(response);
      done += 1;
      broadcast({ type: 'persona:complete', persona: persona.id, label: persona.label, done, total: PANEL_PERSONAS.length });
    }

    if (record.cancelRequested) {
      broadcast({ type: 'canceled', runId, personas: responses.length, canceledAt: new Date().toISOString() });
      return;
    }

    const snapshot = await finalizePanel(seriesId, digest, responses, { runId });
    broadcast({
      type: 'complete',
      runId,
      personas: responses.length,
      consensus: snapshot.disagreements?.consensus?.length || 0,
      seededFindings: snapshot.seededFindings || 0,
      completedAt: new Date().toISOString(),
    });
  });
}

export const __testing = { runs: runner.runs };
