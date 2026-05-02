/**
 * Writers Room — manual AI passes against a draft (evaluate / format / script).
 * Snapshots persist immutably under data/writers-room/works/<id>/analysis/ and
 * pin the source draft's contentHash so the UI can flag stale results.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { readFile, readdir } from 'fs/promises';
import { PATHS, atomicWrite, ensureDir, safeJSONParse } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { stripCodeFences } from '../../lib/aiProvider.js';
import { getActiveProvider } from '../providers.js';
import { buildPrompt } from '../promptService.js';
import { ANALYSIS_KINDS } from '../../lib/writersRoomPresets.js';
import { getWorkWithBody } from './local.js';

export { ANALYSIS_KINDS };

const KIND_META = {
  evaluate: { stage: 'writers-room-evaluate', returnsJson: true },
  format:   { stage: 'writers-room-format',   returnsJson: false },
  script:   { stage: 'writers-room-script',   returnsJson: true },
};

const ANALYSIS_ID_RE = /^wr-analysis-[0-9a-f-]+$/i;

const root = () => join(PATHS.data, 'writers-room');
const analysisDir = (workId) => join(root(), 'works', workId, 'analysis');
const analysisPath = (workId, id) => join(analysisDir(workId), `${id}.json`);

function nowIso() { return new Date().toISOString(); }
function badRequest(msg) { return new ServerError(msg, { status: 400, code: 'VALIDATION_ERROR' }); }
function notFound(what) { return new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' }); }

// ---------- LLM invocation ----------

async function resolveProvider() {
  const active = await getActiveProvider().catch(() => null);
  if (active?.enabled) return active;
  throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
}

async function callApiProvider(provider, model, prompt, temperature) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const response = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    }),
    signal: AbortSignal.timeout(provider.timeout || 300000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AI API error: ${response.status} - ${text.slice(0, 500)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

function callCliProvider(provider, model, prompt) {
  return new Promise((resolve, reject) => {
    const args = [...(provider.args || [])];
    if (provider.headlessArgs?.length) args.push(...provider.headlessArgs);
    const isGeminiCli = provider.id === 'gemini-cli';
    if (isGeminiCli && !args.includes('--output-format') && !args.includes('-o')) {
      args.push('--output-format', 'text');
    }
    if (model) args.push('--model', model);
    // Send the prose via stdin for non-gemini CLIs — adapted-screenplay drafts
    // can run tens of thousands of characters once headings and dialogue are
    // inlined, well past argv ceilings on macOS/Linux.
    const usingStdin = !isGeminiCli;
    if (isGeminiCli) args.push('--prompt', prompt);
    const child = spawn(provider.command, args, {
      env: (() => { const e = { ...process.env, ...provider.envVars }; delete e.CLAUDECODE; return e; })(),
      stdio: [usingStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    const timeoutMs = provider.timeout || 300000;
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI AI call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve(output);
      else reject(new Error(`CLI exited with code ${code}${output ? ': ' + output.slice(0, 500) : ''}`));
    });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
    if (usingStdin) child.stdin.end(prompt);
  });
}

async function callAI(stageName, variables, temperature) {
  const provider = await resolveProvider();
  const prompt = await buildPrompt(stageName, variables);
  let model = provider.defaultModel;
  if (provider.id === 'gemini-cli' && !model) {
    model = provider.lightModel || 'gemini-2.5-flash-lite';
  }
  console.log(`📝 wr eval: ${provider.id} / ${model || '(default)'} / ${stageName}`);
  if (provider.type === 'api') {
    const content = await callApiProvider(provider, model, prompt, temperature);
    return { content, model: model || null, providerId: provider.id };
  }
  if (provider.type === 'cli') {
    const content = await callCliProvider(provider, model, prompt);
    return { content, model: model || null, providerId: provider.id };
  }
  throw new Error(`Unsupported provider type: ${provider.type}`);
}

// ---------- response parsing ----------

function extractJson(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty AI response');
  let str = stripCodeFences(text);
  // Some providers prepend explanation text; pull the first balanced object/array.
  const objMatch = str.match(/[\{\[][\s\S]*[\}\]]/);
  if (objMatch) str = objMatch[0];
  return JSON.parse(str);
}

const SHAPERS = {
  format: (raw) => {
    let text = raw.trim();
    const fence = text.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)```$/);
    if (fence) text = fence[1].trim();
    return { formattedBody: text };
  },
  evaluate: (raw) => {
    const parsed = extractJson(raw);
    return {
      logline: typeof parsed.logline === 'string' ? parsed.logline : null,
      summary: typeof parsed.summary === 'string' ? parsed.summary : null,
      themes: Array.isArray(parsed.themes) ? parsed.themes.filter((t) => typeof t === 'string') : [],
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.filter((s) => typeof s === 'string') : [],
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i) => i && typeof i === 'object') : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s) => s && typeof s === 'object') : [],
    };
  },
  script: (raw) => {
    const parsed = extractJson(raw);
    const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
    return {
      title: typeof parsed.title === 'string' ? parsed.title : null,
      logline: typeof parsed.logline === 'string' ? parsed.logline : null,
      scenes: scenes.map((s, i) => ({
        id: typeof s.id === 'string' ? s.id : `scene-${String(i + 1).padStart(2, '0')}`,
        heading: typeof s.heading === 'string' ? s.heading : `Scene ${i + 1}`,
        slugline: typeof s.slugline === 'string' ? s.slugline : null,
        summary: typeof s.summary === 'string' ? s.summary : '',
        characters: Array.isArray(s.characters) ? s.characters.filter((c) => typeof c === 'string') : [],
        action: typeof s.action === 'string' ? s.action : '',
        dialogue: Array.isArray(s.dialogue) ? s.dialogue.filter((d) => d && typeof d === 'object') : [],
        visualPrompt: typeof s.visualPrompt === 'string' ? s.visualPrompt : '',
        sourceSegmentIds: Array.isArray(s.sourceSegmentIds) ? s.sourceSegmentIds.filter((id) => typeof id === 'string') : [],
      })),
    };
  },
};

// ---------- storage ----------

async function listAnalysisIds(workId) {
  const dir = analysisDir(workId);
  await ensureDir(dir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .filter((id) => ANALYSIS_ID_RE.test(id));
}

async function loadAnalysis(workId, id) {
  const content = await readFile(analysisPath(workId, id), 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (content === null) return null;
  return safeJSONParse(content, null, { allowArray: false, logError: true, context: analysisPath(workId, id) });
}

async function saveAnalysis(workId, snapshot) {
  await ensureDir(analysisDir(workId));
  await atomicWrite(analysisPath(workId, snapshot.id), snapshot);
}

function summarize(a) {
  return {
    id: a.id,
    workId: a.workId,
    kind: a.kind,
    status: a.status,
    draftVersionId: a.draftVersionId,
    sourceContentHash: a.sourceContentHash,
    providerId: a.providerId,
    model: a.model,
    error: a.error || null,
    createdAt: a.createdAt,
    completedAt: a.completedAt,
  };
}

export async function listAnalyses(workId) {
  const ids = await listAnalysisIds(workId);
  const all = await Promise.all(ids.map((id) => loadAnalysis(workId, id)));
  return all
    .filter(Boolean)
    .map(summarize)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function getAnalysis(workId, id) {
  if (!ANALYSIS_ID_RE.test(id)) throw badRequest('Invalid analysis id');
  const a = await loadAnalysis(workId, id);
  if (!a) throw notFound('Analysis');
  return a;
}

// Persist the per-scene generated-image reference on the analysis snapshot so
// the UI can re-show the image after navigation/reload. Scenes are keyed by
// their `result.scenes[i].id`; we don't validate the id against the scene
// list because the LLM occasionally drifts (regenerated analyses can have
// different scene ids) and overwriting an old key is harmless.
export async function attachSceneImage(workId, id, { sceneId, filename, jobId, prompt }) {
  if (!ANALYSIS_ID_RE.test(id)) throw badRequest('Invalid analysis id');
  if (typeof sceneId !== 'string' || !sceneId.trim()) throw badRequest('sceneId required');
  if (typeof filename !== 'string' || !filename.trim()) throw badRequest('filename required');
  const a = await loadAnalysis(workId, id);
  if (!a) throw notFound('Analysis');
  const next = {
    ...a,
    sceneImages: {
      ...(a.sceneImages || {}),
      [sceneId]: {
        filename: filename.trim(),
        jobId: typeof jobId === 'string' ? jobId : null,
        prompt: typeof prompt === 'string' ? prompt : null,
        generatedAt: nowIso(),
      },
    },
  };
  await saveAnalysis(workId, next);
  return next;
}

// ---------- startup recovery ----------

/**
 * Mark any `running` snapshots as `failed`. A server restart kills in-flight
 * LLM calls but the pre-call snapshot is already on disk, so without this the
 * UI would spin forever on a phantom row. Idempotent; called fire-and-forget
 * at boot.
 */
export async function recoverStuckAnalyses() {
  const worksRoot = join(root(), 'works');
  const workEntries = await readdir(worksRoot, { withFileTypes: true }).catch(() => []);
  const counts = await Promise.all(
    workEntries
      .filter((e) => e.isDirectory())
      .map(async (entry) => {
        const ids = await listAnalysisIds(entry.name).catch(() => []);
        const results = await Promise.all(ids.map(async (id) => {
          const a = await loadAnalysis(entry.name, id);
          if (a?.status !== 'running') return 0;
          await saveAnalysis(entry.name, {
            ...a,
            status: 'failed',
            error: 'Server restarted while this analysis was running',
            completedAt: nowIso(),
          });
          return 1;
        }));
        return results.reduce((s, n) => s + n, 0);
      })
  );
  const recovered = counts.reduce((s, n) => s + n, 0);
  if (recovered > 0) console.log(`📝 wr: recovered ${recovered} stuck analysis snapshot(s) on boot`);
}

// ---------- run ----------

export async function runAnalysis(workId, { kind } = {}) {
  if (!ANALYSIS_KINDS.includes(kind)) {
    throw badRequest(`Invalid analysis kind: ${kind}. Expected one of ${ANALYSIS_KINDS.join(', ')}`);
  }
  const { stage, returnsJson } = KIND_META[kind];
  const { manifest, body } = await getWorkWithBody(workId);
  if (!body || !body.trim()) {
    throw badRequest('Cannot analyze an empty draft — write some prose first');
  }
  const draft = (manifest.drafts || []).find((d) => d.id === manifest.activeDraftVersionId);
  const id = `wr-analysis-${randomUUID()}`;
  const baseSnapshot = {
    id,
    workId,
    kind,
    status: 'running',
    draftVersionId: manifest.activeDraftVersionId,
    sourceContentHash: draft?.contentHash || null,
    providerId: null,
    model: null,
    result: null,
    error: null,
    createdAt: nowIso(),
    completedAt: null,
  };
  await saveAnalysis(workId, baseSnapshot);

  // Awaited synchronously by the route — the client gets the finished record
  // back in one round-trip. A failure mid-call is persisted as a `failed`
  // snapshot so partial work never silently disappears.
  try {
    const variables = {
      work: {
        id: manifest.id,
        title: manifest.title,
        kind: manifest.kind,
        status: manifest.status,
        wordCount: draft?.wordCount || 0,
      },
      draftBody: body,
      returnsJson,
    };
    const temperature = kind === 'format' ? 0.2 : 0.4;
    const { content, model: usedModel, providerId: usedProvider } = await callAI(stage, variables, temperature);
    const result = SHAPERS[kind](content);
    const finished = {
      ...baseSnapshot,
      status: 'succeeded',
      providerId: usedProvider,
      model: usedModel,
      result,
      rawResponse: content,
      completedAt: nowIso(),
    };
    await saveAnalysis(workId, finished);
    return finished;
  } catch (err) {
    const failed = {
      ...baseSnapshot,
      status: 'failed',
      error: err.message || String(err),
      completedAt: nowIso(),
    };
    await saveAnalysis(workId, failed);
    return failed;
  }
}
