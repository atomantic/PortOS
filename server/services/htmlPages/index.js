/**
 * HTML Pages bench: run installed local models against the fixed creative HTML brief and keep each model's pages as a durable run for side-by-side comparison.
 *
 * A run targets either an installed local model (`backend` + `modelId`, talked to directly) or a provider route (`route`: any configured provider, model and effort, run through the shared prompt runner with no fallback, so the gallery names what really answered). An MTPLX pack that is downloaded but not serving is a target too: MTPLX is switched to it for the run and switched back after.
 *
 * Runs are queued and executed one at a time under the machine-wide heavy-job claim, each page a separate request. Nothing here runs from boot or a read path: `startRuns` is the only way a model is reached, from an explicit request that named the models and page count. Queued and generating runs are tracked live work (Live activity, the idle verdict and the update preflight see them), so the updater waits for them. A run a restart still cut off is reported as failed and never resumed on its own; `resumeRun` re-queues it from its first unfinished page when the person asks.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';
import { claimHeavyLocalJob } from '../../lib/heavyJobClaim.js';
import { ASSESSABLE_RUNTIMES, LOCAL_RUNTIMES } from '../../lib/localProviderRuntime.js';
import { isEmbeddingModel } from '../../lib/localModelHeuristics.js';
import {
  HTML_BRIEF_MAX_CHARS, HTML_PAGE_DEFAULT_BRIEFS, HTML_PAGES_MAX, htmlPagePrompt, htmlPagePromptParts, extractHtmlDocument, scoreHtmlPage, scoreHtmlPages,
} from '../../lib/htmlPageBench.js';
import { listRuntimeModels } from '../localModelAssessments.js';
import { generate } from '../modelCapabilityTests.js';
import { trackedRenderMap } from '../renderActivity.js';
import { createRun, deleteRun as deleteStoredRun, getRun, listRuns as listStoredRuns, mutateRun } from './db.js';

const ACTIVE = new Set(['queued', 'generating']);
// Thinking models spend most of their budget reasoning before the page starts (8,000 left pages cut off mid-CSS; 24,000 still cut off a 35B thinking model mid-page), and a designed page itself runs several thousand tokens. At ~70 tok/s the cap takes about 12 minutes, inside the page timeout.
const PAGE_MAX_TOKENS = 48_000;
const PAGE_TIMEOUT_MS = 20 * 60 * 1000;
// Within this share of the cap the model was cut off, not finished.
const TRUNCATION_SHARE = 0.98;
// Higher than the capability tests' 0.2: this brief asks for variety.
const PAGE_TEMPERATURE = 0.8;
// One page stored whole so the gallery can render it; this only bounds a runaway generation.
const MAX_PAGE_HTML_CHARS = 120_000;
// How long a queued run waits for another heavy local job before it reports the machine busy.
const CLAIM_WAIT_MS = 10 * 60 * 1000;

const runtimeLabel = (id) => LOCAL_RUNTIMES[id]?.label || id;
// Run-source tag for provider routes; classified operational in lib/creativeLatitude.js, so the prompt goes out exactly as the form showed it.
const RUN_SOURCE = 'html-pages-bench';
// MTPLX serves one pack at a time under a short served id; a downloaded pack is named by its Hugging Face repo id.
const isMtplxCheckpoint = (backend, modelId) => backend === 'mtplx' && String(modelId).includes('/');

/** Downloaded MTPLX packs other than the one serving now: each can be run by switching MTPLX to it. Disk only; nothing is started. */
async function mtplxCheckpointModels() {
  const { getMtplxServerStatus } = await import('../mtplxServerManager.js');
  const status = await getMtplxServerStatus().catch(() => null);
  const serving = status?.running ? status.config?.model : null;
  return (status?.cachedModels || [])
    .filter((repo) => repo !== serving)
    .map((repo) => ({ backend: 'mtplx', runtimeLabel: runtimeLabel('mtplx'), modelId: repo, offline: false, switchesCheckpoint: true }));
}

const queue = [];
// Run id → { controller }, from queueing until the run settles. A run this process holds is live; one marked active without a slot was cut off by a restart.
const liveRuns = trackedRenderMap('html-pages', { noun: 'HTML pages run', link: () => '/html-pages' });
let draining = false;
const isCutOff = (run) => ACTIVE.has(run.status) && !liveRuns.has(run.id);

/** Every installed, chat-capable model across the assessable runtimes, for the picker. Disk/loopback only; no model is called. */
export async function listSelectableModels() {
  const listed = await Promise.all(ASSESSABLE_RUNTIMES.map(async (runtime) => [runtime, await listRuntimeModels(runtime)]));
  const models = [];
  const listErrors = [];
  for (const [runtime, result] of listed) {
    if (result.error) listErrors.push({ id: runtime, label: runtimeLabel(runtime), error: result.error, offline: Boolean(result.offline) });
    // An offline MTPLX lists its downloaded packs, which mtplxCheckpointModels offers as runnable instead.
    if (runtime === 'mtplx' && result.offline) continue;
    for (const model of result.models || []) {
      if (!model?.id || isEmbeddingModel(model.id)) continue;
      models.push({ backend: runtime, runtimeLabel: runtimeLabel(runtime), modelId: model.id, offline: Boolean(result.offline) });
    }
  }
  if (ASSESSABLE_RUNTIMES.includes('mtplx')) models.push(...await mtplxCheckpointModels());
  return {
    models,
    listErrors,
    // What the form starts with, and the fixed text PortOS adds around each brief, so the form can show the exact prompt that will be sent.
    defaultPages: [...HTML_PAGE_DEFAULT_BRIEFS],
    promptParts: htmlPagePromptParts(),
    pageCountMax: HTML_PAGES_MAX,
    briefMaxChars: HTML_BRIEF_MAX_CHARS,
  };
}

/** A run without its generated HTML: the list refetches on every progress event, and the pages are read one run at a time. */
const summarize = (run) => ({ ...run, pages: (run.pages || []).map(({ html, ...page }) => page) });

/** Stored run summaries, newest first. A run still marked active that this process is not working on was cut off by a restart. */
export async function listRuns() {
  const runs = await listStoredRuns();
  const current = await Promise.all(runs.map((run) => (isCutOff(run) ? markInterrupted(run.id) : run)));
  return current.map(summarize);
}

const markInterrupted = (id) => mutateRun(id, (current) => (ACTIVE.has(current.status)
  ? { ...current, status: 'failed', error: 'Interrupted by a server restart before it finished', finishedAt: new Date().toISOString() }
  : null));

export const readRun = async (id) => {
  const run = await getRun(id);
  if (!run) throw new ServerError('HTML pages run not found', { status: 404, code: 'NOT_FOUND' });
  return isCutOff(run) ? markInterrupted(id) : run;
};

/** A provider route resolved to what the run record names; 409 when the provider is gone or switched off. */
async function resolveRoute({ providerId, model, effort }) {
  const { getProviderById } = await import('../provider/providers.js');
  const provider = await getProviderById(providerId).catch(() => null);
  if (!provider || provider.enabled === false) {
    throw new ServerError(`Provider ${providerId} is not available`, { status: 409, code: 'HTML_PAGES_PROVIDER_UNAVAILABLE' });
  }
  const resolvedModel = model || provider.defaultModel || null;
  return { providerId, providerName: provider.name || providerId, model: resolvedModel, effort: effort || null };
}

/**
 * Queue one run per selected local model and per provider route. Local models are checked against what is installed right now and routes against the configured providers, so a typo or a stopped runtime is a 409 up front rather than a failed run later.
 */
export async function startRuns({ models = [], routes = [], pages }) {
  const { models: installed } = await listSelectableModels();
  const missing = models.filter((m) => !installed.some((i) => i.backend === m.backend && i.modelId === m.modelId));
  if (missing.length) {
    throw new ServerError(`${missing[0].modelId} is not installed on ${runtimeLabel(missing[0].backend)}`, {
      status: 409, code: 'HTML_PAGES_MODEL_UNAVAILABLE', context: { missing: missing.length },
    });
  }
  const resolvedRoutes = await Promise.all(routes.map(resolveRoute));
  // The exact prompt each page sends is recorded on the run, so a later change to the fixed text never rewrites what an old run was asked.
  const prompts = pages.map(htmlPagePrompt);
  const runs = [];
  const targets = [
    ...models.map((m) => ({ backend: m.backend, modelId: m.modelId, route: null })),
    ...resolvedRoutes.map((route) => ({ backend: 'provider', modelId: route.model || route.providerName, route })),
  ];
  for (const target of targets) {
    const run = await createRun({ ...target, pageCount: pages.length, themes: pages, prompts });
    enqueue(run.id);
    runs.push(run);
  }
  console.log(`🧩 HTML pages: queued ${runs.length} run${runs.length === 1 ? '' : 's'} of ${pages.length} page${pages.length === 1 ? '' : 's'}`);
  void drain();
  return runs;
}

/** A run worth retrying: failed or cut off (a queued/generating row nothing is working on, which resumeRun has already ruled out), or finished with a page that did not pass every check. */
const isRetryable = (run) => run.status !== 'complete' || run.pages.some((page) => !page.html || page.passed !== page.total);

const enqueue = (id) => {
  liveRuns.set(id, { controller: new AbortController() });
  queue.push(id);
};

/**
 * Re-queue a failed or cut-off run, or a finished one with a page that failed a check, on the same model with the prompts it recorded. It keeps the pages before the first one that did not pass every check and regenerates from there. Only an explicit request reaches here.
 */
export async function resumeRun(id) {
  if (liveRuns.has(id)) throw new ServerError('That run is already queued or generating', { status: 409, code: 'HTML_PAGES_RUN_ACTIVE' });
  // Held before the write so a concurrent read cannot see the re-queued row as cut off.
  liveRuns.set(id, { controller: new AbortController() });
  let run;
  try {
    run = await mutateRun(id, (current) => {
      if (!isRetryable(current)) return null;
      const firstMissing = current.pages.findIndex((page) => !page.html || page.passed !== page.total);
      const pages = firstMissing < 0 ? current.pages : current.pages.slice(0, firstMissing);
      return {
        ...current, status: 'queued', pages, progress: { done: pages.length, total: current.pageCount }, detail: null, error: null, finishedAt: null,
      };
    });
  } catch (err) {
    liveRuns.delete(id);
    throw err;
  }
  if (run.status !== 'queued') {
    liveRuns.delete(id);
    throw new ServerError('Only a failed run, or one with a page that failed a check, can be retried', { status: 409, code: 'HTML_PAGES_RUN_NOT_RESUMABLE' });
  }
  queue.push(id);
  console.log(`🧩 HTML pages: resuming ${run.modelId} from page ${run.pages.length + 1} of ${run.pageCount}`);
  void drain();
  return summarize(run);
}

/** Soft-delete a run. A run still generating is stopped first. */
export async function removeRun(id) {
  const index = queue.indexOf(id);
  if (index >= 0) {
    queue.splice(index, 1);
    liveRuns.delete(id);
  }
  liveRuns.get(id)?.controller.abort();
  return deleteStoredRun(id);
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      await processRun(id)
        .catch((err) => console.log(`🧩 HTML pages: run ${id} stopped: ${err.message}`))
        .finally(() => liveRuns.delete(id));
    }
  } finally {
    draining = false;
  }
}

async function processRun(id) {
  const run = await getRun(id);
  if (!run || run.deleted || run.status !== 'queued') return;
  const { controller } = liveRuns.get(id);
  let claim = null;
  try {
    claim = await claimHeavyLocalJob({ kind: 'html pages bench', id: `${run.backend}/${run.modelId}`, timeoutMs: CLAIM_WAIT_MS });
    if (!claim.ok) throw new ServerError(claim.message, { status: 409, code: 'HEAVY_LOCAL_JOB_BUSY' });
    await mutateRun(id, (c) => ({ ...c, status: 'generating', startedAt: new Date().toISOString() }));
    console.log(`🧩 HTML pages: ${run.modelId} on ${run.route?.providerName || runtimeLabel(run.backend)} — ${run.themes.length - run.pages.length} page(s)`);

    const generatePages = async (send) => {
      for (const [index, theme] of run.themes.entries()) {
        // A resumed run keeps the pages it already finished.
        if (index < run.pages.length) continue;
        if (controller.signal.aborted) return;
        const startedAt = Date.now();
        const result = await send(run.prompts?.[index] ?? htmlPagePrompt(theme));
        if (controller.signal.aborted) return;
        // Cut to the document, never repaired: a truncated page must read as truncated.
        const html = extractHtmlDocument(String(result?.text || '')).slice(0, MAX_PAGE_HTML_CHARS);
        const page = {
          theme,
          html,
          ...scoreHtmlPage(html),
          error: result?.error || null,
          // The runtime reported using (nearly) the whole token budget: the page, or the reasoning before it, was cut off.
          hitTokenLimit: Number.isFinite(result?.timings?.completionTokens) ? result.timings.completionTokens >= PAGE_MAX_TOKENS * TRUNCATION_SHARE : null,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          tokensPerSecond: result?.timings?.tokensPerSecond ?? null,
        };
        await mutateRun(id, (c) => ({ ...c, pages: [...c.pages, page], progress: { done: c.pages.length + 1, total: c.pageCount } }));
      }
    };
    const local = (modelId) => (prompt) => generate({
      backend: run.backend, modelId, prompt, maxTokens: PAGE_MAX_TOKENS,
      temperature: PAGE_TEMPERATURE, timeoutMs: PAGE_TIMEOUT_MS, signal: controller.signal,
    });
    if (run.route) {
      await generatePages((prompt) => generateViaProvider(run.route, prompt, controller.signal));
    } else if (isMtplxCheckpoint(run.backend, run.modelId)) {
      const { runOnMtplxCheckpoint } = await import('../mtplxServerManager.js');
      await runOnMtplxCheckpoint(run.modelId, (served) => generatePages(local(served || run.modelId)));
    } else {
      await generatePages(local(run.modelId));
    }
    if (controller.signal.aborted) return;

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
    await claim?.release?.();
  }
}

/**
 * One page through a provider route: the configured provider, model and effort exactly as picked, no fallback (the gallery must name what answered) and tool-free (the reply is the page, not files an agent wrote). Resolves to the same `{ text, error, timings }` shape `generate` does.
 */
async function generateViaProvider(route, prompt, signal) {
  const [{ getProviderById }, { runPromptThroughProvider }, { stopRun }] = await Promise.all([
    import('../provider/providers.js'), import('../promptRunner.js'), import('../runner.js'),
  ]);
  const provider = await getProviderById(route.providerId).catch(() => null);
  if (!provider) return { text: '', error: `Provider ${route.providerName || route.providerId} is not available`, timings: null };
  let runId = null;
  const stop = () => { if (runId) stopRun(runId).catch(() => { /* best-effort cancel */ }); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const result = await runPromptThroughProvider({
      provider, model: route.model || undefined, effort: route.effort || undefined, prompt,
      source: RUN_SOURCE, timeout: PAGE_TIMEOUT_MS, allowFallback: false, toolFree: true, cwd: PATHS.data,
      onRunCreated: (createdId) => { runId = createdId; if (signal.aborted) stop(); },
    });
    // A CLI transcript can echo the prompt, whose rules mention `<!doctype html>`; drop it so only the reply is read.
    return { text: String(result?.text || '').split(prompt).join(''), error: null, timings: null };
  } catch (err) {
    return { text: '', error: err?.message || 'The provider run failed', timings: null };
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
