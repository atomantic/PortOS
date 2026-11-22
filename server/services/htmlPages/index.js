/**
 * HTML Pages bench: run installed local models against the fixed creative HTML brief and keep each model's pages as a durable run for side-by-side comparison.
 *
 * Runs are queued and executed one at a time under the machine-wide heavy-job claim, each page a separate request. Nothing here runs from boot or a read path: `startRuns` is the only way a model is reached, from an explicit request that named the models and page count. A run left queued or generating by a restart is reported as failed, never resumed.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { claimHeavyLocalJob } from '../../lib/heavyJobClaim.js';
import { ASSESSABLE_RUNTIMES, LOCAL_RUNTIMES } from '../../lib/localProviderRuntime.js';
import { isEmbeddingModel } from '../../lib/localModelHeuristics.js';
import {
  HTML_PAGE_THEMES, HTML_PAGES_DEFAULT, HTML_PAGES_MAX, htmlPagePrompt, extractHtmlDocument, scoreHtmlPage, scoreHtmlPages,
} from '../../lib/htmlPageBench.js';
import { listRuntimeModels } from '../localModelAssessments.js';
import { generate } from '../modelCapabilityTests.js';
import { createRun, deleteRun as deleteStoredRun, getRun, listRuns as listStoredRuns, mutateRun } from './db.js';

const ACTIVE = new Set(['queued', 'generating']);
// A designed page with inline script and styles runs several thousand tokens; a slow model needs minutes for one.
const PAGE_MAX_TOKENS = 8000;
const PAGE_TIMEOUT_MS = 10 * 60 * 1000;
// Higher than the capability tests' 0.2: this brief asks for variety.
const PAGE_TEMPERATURE = 0.8;
// One page stored whole so the gallery can render it; this only bounds a runaway generation.
const MAX_PAGE_HTML_CHARS = 120_000;
// How long a queued run waits for another heavy local job before it reports the machine busy.
const CLAIM_WAIT_MS = 10 * 60 * 1000;

const runtimeLabel = (id) => LOCAL_RUNTIMES[id]?.label || id;

const queue = [];
const controllers = new Map();
let draining = false;

/** The themes a run of `pageCount` pages asks for, in order. */
export const themesFor = (pageCount) => HTML_PAGE_THEMES.slice(0, pageCount);

/** Every installed, chat-capable model across the assessable runtimes, for the picker. Disk/loopback only; no model is called. */
export async function listSelectableModels() {
  const listed = await Promise.all(ASSESSABLE_RUNTIMES.map(async (runtime) => [runtime, await listRuntimeModels(runtime)]));
  const models = [];
  const listErrors = [];
  for (const [runtime, result] of listed) {
    if (result.error) listErrors.push({ id: runtime, label: runtimeLabel(runtime), error: result.error, offline: Boolean(result.offline) });
    for (const model of result.models || []) {
      if (!model?.id || isEmbeddingModel(model.id)) continue;
      models.push({ backend: runtime, runtimeLabel: runtimeLabel(runtime), modelId: model.id, offline: Boolean(result.offline) });
    }
  }
  return {
    models,
    listErrors,
    themes: [...HTML_PAGE_THEMES],
    // Shown at the form so the person can read exactly what each page request sends before agreeing to a run.
    promptExample: htmlPagePrompt(HTML_PAGE_THEMES[0]),
    pageCountMax: HTML_PAGES_MAX,
    pageCountDefault: HTML_PAGES_DEFAULT,
  };
}

/** A run without its generated HTML: the list refetches on every progress event, and the pages are read one run at a time. */
const summarize = (run) => ({ ...run, pages: (run.pages || []).map(({ html, ...page }) => page) });

/** Stored run summaries, newest first. A run still marked active that this process is not working on was cut off by a restart. */
export async function listRuns() {
  const runs = await listStoredRuns();
  const current = await Promise.all(runs.map((run) => (ACTIVE.has(run.status) && !controllers.has(run.id) && !queue.includes(run.id)
    ? markInterrupted(run.id)
    : run)));
  return current.map(summarize);
}

const markInterrupted = (id) => mutateRun(id, (current) => (ACTIVE.has(current.status)
  ? { ...current, status: 'failed', error: 'Interrupted by a server restart before it finished', finishedAt: new Date().toISOString() }
  : null));

export const readRun = async (id) => {
  const run = await getRun(id);
  if (!run) throw new ServerError('HTML pages run not found', { status: 404, code: 'NOT_FOUND' });
  return ACTIVE.has(run.status) && !controllers.has(run.id) && !queue.includes(run.id) ? markInterrupted(id) : run;
};

/**
 * Queue one run per selected model. The selection is checked against what is installed right now, so a typo or a stopped runtime is a 409 up front rather than a failed run later.
 */
export async function startRuns({ models, pageCount = HTML_PAGES_DEFAULT }) {
  const { models: installed } = await listSelectableModels();
  const missing = models.filter((m) => !installed.some((i) => i.backend === m.backend && i.modelId === m.modelId));
  if (missing.length) {
    throw new ServerError(`${missing[0].modelId} is not installed on ${runtimeLabel(missing[0].backend)}`, {
      status: 409, code: 'HTML_PAGES_MODEL_UNAVAILABLE', context: { missing: missing.length },
    });
  }
  const themes = themesFor(pageCount);
  const runs = [];
  for (const m of models) {
    const run = await createRun({ backend: m.backend, modelId: m.modelId, pageCount: themes.length, themes });
    queue.push(run.id);
    runs.push(run);
  }
  console.log(`🧩 HTML pages: queued ${runs.length} run${runs.length === 1 ? '' : 's'} of ${themes.length} page${themes.length === 1 ? '' : 's'}`);
  void drain();
  return runs;
}

/** Soft-delete a run. A run still generating is stopped first. */
export async function removeRun(id) {
  const index = queue.indexOf(id);
  if (index >= 0) queue.splice(index, 1);
  controllers.get(id)?.abort();
  return deleteStoredRun(id);
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      await processRun(id).catch((err) => console.log(`🧩 HTML pages: run ${id} stopped: ${err.message}`));
    }
  } finally {
    draining = false;
  }
}

async function processRun(id) {
  const run = await getRun(id);
  if (!run || run.deleted || run.status !== 'queued') return;
  const controller = new AbortController();
  controllers.set(id, controller);
  let claim = null;
  try {
    claim = await claimHeavyLocalJob({ kind: 'html pages bench', id: `${run.backend}/${run.modelId}`, timeoutMs: CLAIM_WAIT_MS });
    if (!claim.ok) throw new ServerError(claim.message, { status: 409, code: 'HEAVY_LOCAL_JOB_BUSY' });
    await mutateRun(id, (c) => ({ ...c, status: 'generating', startedAt: new Date().toISOString() }));
    console.log(`🧩 HTML pages: ${run.modelId} on ${runtimeLabel(run.backend)} — ${run.themes.length} page(s)`);

    for (const theme of run.themes) {
      if (controller.signal.aborted) return;
      const startedAt = Date.now();
      const result = await generate({
        backend: run.backend, modelId: run.modelId, prompt: htmlPagePrompt(theme), maxTokens: PAGE_MAX_TOKENS,
        temperature: PAGE_TEMPERATURE, timeoutMs: PAGE_TIMEOUT_MS, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      // Cut to the document, never repaired: a truncated page must read as truncated.
      const html = extractHtmlDocument(String(result?.text || '')).slice(0, MAX_PAGE_HTML_CHARS);
      const page = {
        theme,
        html,
        ...scoreHtmlPage(html),
        error: result?.error || null,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        tokensPerSecond: result?.timings?.tokensPerSecond ?? null,
      };
      await mutateRun(id, (c) => ({ ...c, pages: [...c.pages, page], progress: { done: c.pages.length + 1, total: c.pageCount } }));
    }

    await mutateRun(id, (c) => {
      const detail = scoreHtmlPages(c.pages);
      const failedAll = c.pages.length > 0 && c.pages.every((p) => !p.html && p.error);
      return {
        ...c,
        status: failedAll ? 'failed' : 'complete',
        detail,
        error: failedAll ? c.pages[0].error : null,
        finishedAt: new Date().toISOString(),
      };
    });
  } catch (err) {
    console.log(`🧩 HTML pages: ${run.modelId} failed: ${err.message}`);
    await mutateRun(id, (c) => (c.deleted ? null : { ...c, status: 'failed', error: err.message, finishedAt: new Date().toISOString() })).catch(() => null);
  } finally {
    controllers.delete(id);
    await claim?.release?.();
  }
}
