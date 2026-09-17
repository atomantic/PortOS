/** SWE-bench leaderboard sync for the model comparison catalog; see docs/MODEL-COMPARISON.md. */
import { ServerError } from '../lib/errorHandler.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { modelComparisonImportSchema } from '../lib/validation.js';
import { importModelComparison } from './modelComparison.js';
import { slugify, KNOWN_EFFORTS } from './artificialAnalysis.js';

const SWEBENCH_URL = 'https://www.swebench.com/';
const SWEBENCH_REQUEST_TIMEOUT_MS = 30_000;
// Scored tracks only — "Test" is the site's system-test playground tab, not a
// leaderboard an operator compares within.
const SWEBENCH_TRACKS = new Set(['Verified', 'Lite', 'Multilingual', 'Multimodal']);
// No attributable model identity — a run of an undisclosed or multi-vendor
// lineup cannot be plotted as one model, so the row stays absent.
const UNATTRIBUTABLE_MODELS = new Set(['undisclosed', 'multiple', '']);

export async function fetchSwebenchLeaderboards() {
  let res;
  try {
    res = await fetchWithTimeout(SWEBENCH_URL, {}, SWEBENCH_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ServerError('SWE-bench request timed out; retry sync', { status: 502 });
    }
    throw error;
  }
  if (!res.ok) {
    throw new ServerError(`SWE-bench request failed (${res.status}): ${res.statusText || 'request rejected'}`, { status: 502 });
  }
  const html = await res.text();
  const script = String(html || '').match(/<script type="application\/json" id="leaderboard-data">([\s\S]*?)<\/script>/);
  if (!script) {
    throw new ServerError('SWE-bench page returned no leaderboard data; retry sync', { status: 502 });
  }
  const leaderboards = JSON.parse(script[1]);
  if (!Array.isArray(leaderboards) || !leaderboards.length) {
    throw new ServerError('SWE-bench returned invalid leaderboard data; retry sync', { status: 502 });
  }
  return leaderboards;
}

export function transformSwebenchResultsToObservations(leaderboards, { retrievedAt = new Date().toISOString() } = {}) {
  const observations = [];
  for (const board of leaderboards) {
    if (!board || !board.name || !Array.isArray(board.results)) continue;
    const track = board.name;
    if (!SWEBENCH_TRACKS.has(track)) continue;
    const trackSlug = slugify(track);
    for (const result of board.results) {
      if (!result) continue;
      const modelDisplay = typeof result.model_display === 'string' ? result.model_display.trim() : '';
      const modelSlug = slugify(modelDisplay);
      if (UNATTRIBUTABLE_MODELS.has(modelSlug)) continue;
      const resolved = Number.isFinite(result.resolved) ? result.resolved : null;
      const instanceCost = Number.isFinite(result.instance_cost) ? result.instance_cost : null;
      if (resolved === null && instanceCost === null) continue;
      const agent = typeof result.agent === 'string' && result.agent.trim() ? result.agent.trim() : 'unspecified';
      const agentSlug = slugify(agent);
      const folder = typeof result.folder === 'string' && result.folder ? result.folder : `${result.date || 'undated'}-${agent}-${modelDisplay}`;
      const effort = typeof result.reasoning_effort === 'string' && KNOWN_EFFORTS.includes(result.reasoning_effort) ? result.reasoning_effort : 'unspecified';
      const notes = [
        `SWE-bench ${track} submission (${folder}); agent scaffold ${agent}.`,
        ...(Array.isArray(result.tags) && result.tags.length ? [result.tags.join('; ') + '.'] : []),
        ...(result.warning ? [`Leaderboard warning: ${result.warning}.`] : []),
      ].join(' ');

      observations.push({
        // The submission folder IS the run identity — it is stable across syncs
        // regardless of leaderboard row order, and it disambiguates the several
        // submissions one model+agent pair can carry.
        id: `swebench-${trackSlug}-${modelSlug}-${agentSlug}-${slugify(folder)}`,
        provider: typeof result.model_org === 'string' && result.model_org.trim() ? result.model_org.trim() : 'Unknown',
        model: modelSlug,
        effort,
        configuration: `${agent}; SWE-bench submission ${folder}`.slice(0, 500),
        billing: instanceCost !== null ? 'api' : 'unknown',
        benchmark: `SWE-bench ${track} (pass@1, ${agent})`,
        quality: resolved !== null ? {
          value: Math.round(resolved * 100) / 100,
          source: {
            url: SWEBENCH_URL,
            retrievedAt,
            methodology: `SWE-bench ${track} pass@1 resolved-task percentage; agent scaffold ${agent}.`,
          },
        } : null,
        costPerTask: instanceCost !== null ? {
          value: Math.round(instanceCost * 10000) / 10000,
          source: {
            url: SWEBENCH_URL,
            retrievedAt,
            methodology: `SWE-bench ${track} agent run, mean USD cost per instance.`,
          },
        } : null,
        inputPerMillion: null,
        outputPerMillion: null,
        reasoningPerMillion: null,
        responseSeconds: null,
        tokensPerSecond: null,
        quota: null,
        notes: notes.slice(0, 2000),
      });
    }
  }
  return observations;
}

export async function syncSwebenchCatalog() {
  const leaderboards = await fetchSwebenchLeaderboards();
  const observations = transformSwebenchResultsToObservations(leaderboards);
  if (!observations.length) {
    throw new ServerError('SWE-bench returned no attributable observations; retry sync', { status: 502 });
  }
  const validated = modelComparisonImportSchema.parse({ schemaVersion: 1, observations });
  const updated = await importModelComparison(validated);
  return {
    success: true,
    fetched: leaderboards.reduce((sum, board) => sum + (Array.isArray(board?.results) ? board.results.length : 0), 0),
    observations: observations.length,
    total: updated.observations.length,
    catalog: updated,
  };
}
