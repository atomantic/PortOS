// Backend-specific model provisioning for voice.
//
// Voice's RUNTIME chat path is already provider-agnostic: `resolveLlmEndpoint`
// in llm.js speaks OpenAI-compatible HTTP to any `type: 'api'` provider with an
// endpoint. What is NOT portable is the work of getting a tool-capable model
// onto the machine and warm before the first turn — listing what is installed,
// pulling one that is not, and pre-loading it so the user doesn't pay a cold
// start. Each local backend does that its own way, so it lives behind this
// registry instead of being hardcoded to LM Studio in bootstrap.js.
//
// A provisioner is intentionally the SMALL surface bootstrap needs. Anything a
// backend cannot do degrades to a skip, never a throw — provisioning is a
// convenience on top of a stack that must still come up without it.
//
// **The `listModels` sentinel is load-bearing.** `null` means "we could not
// ask" (daemon down, CLI missing, HTTP error); `[]` means "we asked and the
// backend has nothing installed". Collapsing the two is what made voice chase
// a four-entry install chain on every boot against an unreachable LM Studio.
// Callers MUST branch on `null` explicitly and never on `.length` alone — see
// the "Sentinel + validate" rule in AGENTS.md.

import { promisify } from 'util';
import { execFile } from '../../lib/childProcess.js';
import { whichFirst } from '../../lib/processEnv.js';
import { isToolCapable, isReasoningModel } from './llm.js';
import { DEFAULT_VOICE_BACKEND } from './config.js';
import { LOCAL_LLM_CATALOG } from '../../lib/localLlmCatalog.js';
import { normalizeOpenAiBaseUrl } from '../../lib/localProviderRuntime.js';
import * as ollamaManager from '../ollamaManager.js';

const pexec = promisify(execFile);

// Above this rough parameter count (in B), a model is too heavy for a snappy
// single-user voice agent on Apple Silicon — TTFT balloons and it competes for
// VRAM with anything else loaded. We treat "tool-capable but huge" as
// effectively missing and install a small one alongside.
export const FAST_VOICE_MODEL_MAX_B = 10;

// Approximate parameter count from a model id. Returns Infinity for ids with
// no `<n>B` suffix (utility models, embeddings) so they sort last rather than
// silently winning a tie.
export const sizeOf = (id) => {
  const n = String(id).toLowerCase();
  const moe = n.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/);
  if (moe) return parseFloat(moe[1]) * parseFloat(moe[2]);
  const m = n.match(/(\d+(?:\.\d+)?)\s*b\b/);
  return m ? parseFloat(m[1]) : Infinity;
};

/**
 * A catalog entry's `params` string ("7B", "270M", "3.8B") as a number of
 * billions.
 *
 * Distinct from `sizeOf`, which parses a model ID and only understands a `B`
 * suffix. A sub-billion entry writes its size in MILLIONS, so running ids
 * through `sizeOf` scores `270M` as Infinity and sorts the smallest,
 * fastest function-calling specialist in the catalog LAST in the install
 * chain — the opposite of what the chain is for.
 */
export const paramsToB = (params) => {
  const m = String(params).trim().match(/^(\d+(?:\.\d+)?)\s*([bm])\b/i);
  if (!m) return Infinity;
  return m[2].toLowerCase() === 'm' ? parseFloat(m[1]) / 1000 : parseFloat(m[1]);
};

/**
 * Install targets for `backend`, derived from the curated catalog rather than
 * a second hardcoded list: small, tool-capable, non-reasoning, smallest first.
 *
 * The previous LM Studio chain was a hand-maintained copy of catalog ids with
 * a comment asking the next editor to keep the two in sync. Deriving it means
 * adding a small tool model to the catalog arms it for voice on every backend
 * that has an id for it, and a retired id can't linger here.
 *
 * `PORTOS_VOICE_DEFAULT_TOOL_MODEL` still overrides the whole chain with one id.
 */
export const CHAIN_ENTRIES = (backend) => LOCAL_LLM_CATALOG
  .filter(entry => entry?.capabilities?.includes('tools')
    && !entry.capabilities.includes('reasoning')
    && typeof entry[backend] === 'string'
    && paramsToB(entry.params || '') <= FAST_VOICE_MODEL_MAX_B)
  .sort((a, b) => paramsToB(a.params || '') - paramsToB(b.params || ''));

export const defaultToolModelChain = (backend) => {
  const override = process.env.PORTOS_VOICE_DEFAULT_TOOL_MODEL;
  if (override) return [override];
  return CHAIN_ENTRIES(backend).map(entry => entry[backend]);
};

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

// Ollama reports a model's capability set (`["completion","tools","vision"]`)
// from /api/show, so tool support is a FACT here rather than the id-substring
// guess `isToolCapable` has to make for LM Studio. `getModelCapabilities`
// returns null when the per-model probe fails — treat that as "unknown", and
// fall back to the id heuristic rather than declaring a model tool-less.
const ollamaToolCapable = async (id) => {
  const capabilities = await ollamaManager.getModelCapabilities(id).catch(() => null);
  return capabilities === null ? isToolCapable(id) : capabilities.includes('tools');
};

const ollamaProvisioner = {
  id: 'ollama',
  label: 'Ollama',
  remedy: 'start Ollama (`ollama serve`) or set voice.llm.provider to another backend',
  listModels: async () => {
    const models = await ollamaManager.getInstalledModels().catch(() => null);
    // getInstalledModels returns [] both for "daemon down" and "no models", but
    // it records WHY in getLastInstalledModelsError — a non-null error with an
    // empty list means we could not ask, which is this layer's `null`.
    if (!Array.isArray(models)) return null;
    if (!models.length && ollamaManager.getLastInstalledModelsError()) return null;
    return models.map(m => m.id || m.name).filter(Boolean);
  },
  isToolCapable: ollamaToolCapable,
  chain: () => defaultToolModelChain('ollama'),
  install: async (target) => {
    const result = await ollamaManager.pullModel(target).catch(err => ({ success: false, error: err?.message }));
    return { ok: result?.success === true, reason: result?.error || 'unknown' };
  },
  loadedModels: async () => {
    const loaded = await ollamaManager.getLoadedModels().catch(() => []);
    return new Set((loaded || []).map(m => m.id || m.name).filter(Boolean));
  },
  // Ollama has no separate "load" verb — an empty-prompt generate with a
  // non-zero keep_alive is the documented way to make a model resident
  // (`ollamaManager.warmModel`). Keeping the warm-up behind the provisioner is
  // what lets bootstrap stay backend-agnostic.
  load: async (model) => {
    const started = await ollamaManager.ensureRunning().catch(() => null);
    if (started && started.success === false) {
      return { ok: false, reason: started.error || 'Ollama is not running' };
    }
    const result = await ollamaManager.warmModel(model);
    return { ok: result.warmed === true, reason: result.reason || '' };
  },
};

// ---------------------------------------------------------------------------
// LM Studio
// ---------------------------------------------------------------------------

// `/v1` is appended per-call below, so strip it here. Goes through the shared
// normalizer so a scheme-less host from the env is still a fetchable URL.
const LMS_BASE = () => normalizeOpenAiBaseUrl(process.env.LM_STUDIO_URL || 'http://localhost:1234')
  .replace(/\/v1$/, '');

// Pick the last non-empty line (the `lms` CLI trails newlines) so a failure
// reason is actionable instead of an empty `()`. Combine with stdout when
// stderr is empty — `lms` sometimes routes errors to stdout.
const lastMeaningfulLine = (s) => String(s || '').split('\n').map(l => l.trim()).filter(Boolean).pop() || '';

const lmStudioProvisioner = {
  id: 'lmstudio',
  label: 'LM Studio',
  remedy: 'start the LM Studio local server, or set voice.llm.provider to another backend',
  listModels: async () => {
    const res = await fetch(`${LMS_BASE()}/v1/models`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    // `null`, not `[]`: an unreachable server is "could not ask", and the
    // caller must not read it as "no models installed, go download one".
    if (!res?.ok) return null;
    const body = await res.json().catch(() => null);
    // A 200 whose body doesn't match the OpenAI-compatible `{data: [...]}`
    // shape (truncated response, a gateway returning HTML) means we still
    // could not actually ask — same as unreachable, not "0 models".
    if (!Array.isArray(body?.data)) return null;
    return body.data.map(m => m?.id).filter(Boolean);
  },
  // LM Studio's OpenAI-compatible /v1/models carries no capability field, so
  // tool support stays an id heuristic here.
  isToolCapable: async (id) => isToolCapable(id),
  chain: () => defaultToolModelChain('lmstudio'),
  install: async (target) => {
    const lms = await whichFirst('lms');
    if (!lms) return { ok: false, reason: "'lms' CLI not on PATH" };
    const { stdout, stderr } = await pexec(lms, ['get', '-y', target], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    }).catch(err => ({ stdout: '', stderr: err?.message || String(err) }));
    const reason = lastMeaningfulLine(stderr) || lastMeaningfulLine(stdout) || 'unknown';
    // `lms get` exit status is not a reliable success signal; the caller
    // re-lists and diffs against a pre-install snapshot instead.
    return { ok: true, reason };
  },
  // `lms load` is NOT idempotent — re-loading an already-loaded model spawns a
  // SECOND instance, doubling VRAM. Worse, when VRAM is full the second load
  // fails with "Model loading was stopped due to insufficient system
  // resources" and preload reports failure though the original is fine.
  loadedModels: async () => {
    const lms = await whichFirst('lms');
    if (!lms) return new Set();
    const { stdout } = await pexec(lms, ['ps', '--json'], { timeout: 10_000 }).catch(() => ({ stdout: '' }));
    const parsed = (() => { try { return JSON.parse(stdout || '[]'); } catch { return []; } })();
    return new Set(parsed.map(m => m.modelKey).filter(Boolean));
  },
  load: async (model) => {
    const lms = await whichFirst('lms');
    if (!lms) return { ok: false, reason: "'lms' CLI not on PATH" };
    // `lms load` blocks until ready (5–30s cold). The caller runs this
    // fire-and-forget so reconcile returns immediately.
    await pexec(lms, ['load', model], { timeout: 5 * 60 * 1000 });
    return { ok: true, reason: '' };
  },
};

const PROVISIONERS = {
  [ollamaProvisioner.id]: ollamaProvisioner,
  [lmStudioProvisioner.id]: lmStudioProvisioner,
};

/**
 * The provisioner for `providerId`, or `null` when that provider needs no
 * local provisioning.
 *
 * A remote OpenAI-compatible provider (OpenAI, Groq, a self-hosted vLLM) serves
 * its own models — there is nothing to pull or pre-warm, so returning `null` is
 * the correct answer rather than an error. `sortPreferred` / the chat path
 * still work against it through `resolveLlmEndpoint`.
 */
export { DEFAULT_VOICE_BACKEND };

export const getVoiceProvisioner = (providerId) => PROVISIONERS[providerId] || null;

/** Rank installed models the way voice's `auto` picks: fast and non-reasoning first. */
export const sortPreferred = (ids) => ids.slice().sort((a, b) => {
  const ar = isReasoningModel(a) ? 1 : 0;
  const br = isReasoningModel(b) ? 1 : 0;
  if (ar !== br) return ar - br;
  return sizeOf(a) - sizeOf(b);
});
