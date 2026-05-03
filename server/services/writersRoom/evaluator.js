/**
 * Writers Room — manual AI passes against a draft (evaluate / format / script).
 * Snapshots persist immutably under data/writers-room/works/<id>/analysis/ and
 * pin the source draft's contentHash so the UI can flag stale results.
 */

import { join } from 'path';
import { spawn } from 'child_process';
import { readFile, readdir, rm } from 'fs/promises';
import { PATHS, atomicWrite, ensureDir, safeJSONParse } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { stripCodeFences } from '../../lib/aiProvider.js';
import { getActiveProvider, getProviderById } from '../providers.js';
import { buildPrompt, getStage } from '../promptService.js';
import { ANALYSIS_KINDS } from '../../lib/writersRoomPresets.js';
import { getWorkWithBody } from './local.js';
import { listCharacters, mergeExtractedCharacters } from './characters.js';
import { listSettings, mergeExtractedSettings } from './settings.js';
import { nowIso, badRequest, notFound } from './_shared.js';

export { ANALYSIS_KINDS };

const KIND_META = {
  evaluate:   { stage: 'writers-room-evaluate',   returnsJson: true },
  format:     { stage: 'writers-room-format',     returnsJson: false },
  script:     { stage: 'writers-room-script',     returnsJson: true },
  characters: { stage: 'writers-room-characters', returnsJson: true },
  settings:   { stage: 'writers-room-settings',   returnsJson: true },
};

// Analysis id == kind. Each work keeps at most one snapshot per kind on disk
// (re-running a kind overwrites the previous snapshot via atomicWrite).
const isValidAnalysisId = (id) => typeof id === 'string' && ANALYSIS_KINDS.includes(id);
const LEGACY_ANALYSIS_ID_RE = /^wr-analysis-[0-9a-f-]+$/i;

const root = () => join(PATHS.data, 'writers-room');
const analysisDir = (workId) => join(root(), 'works', workId, 'analysis');
const analysisPath = (workId, id) => join(analysisDir(workId), `${id}.json`);

// ---------- LLM invocation ----------

// Tier names used in stage configs (PromptManager UI). Map to the provider's
// configured per-tier model id; an unset tier falls back to defaultModel so
// stages with `model: 'heavy'` still run on providers that don't break out tiers.
const TIER_TO_MODEL_KEY = {
  default: 'defaultModel',
  quick: 'lightModel',
  coding: 'mediumModel',
  heavy: 'heavyModel',
};

function isTierName(model) {
  return typeof model === 'string' && model in TIER_TO_MODEL_KEY;
}

function resolveModel(provider, stageModel) {
  if (!stageModel) return provider.defaultModel || null;
  if (isTierName(stageModel)) {
    return provider[TIER_TO_MODEL_KEY[stageModel]] || provider.defaultModel || null;
  }
  return stageModel;
}

// Stage config can pin a specific provider via `stage.provider`. When set we
// must use that provider (or fail) — falling back to the active provider would
// silently route the call through whatever's currently selected, defeating the
// whole point of the per-stage override.
async function resolveProviderForStage(stage) {
  if (stage?.provider) {
    const pinned = await getProviderById(stage.provider).catch(() => null);
    if (pinned?.enabled) return pinned;
    throw new ServerError(
      `Stage provider "${stage.provider}" is not available — re-pick a provider in Prompts or the Storyboard settings`,
      { status: 503, code: 'STAGE_PROVIDER_UNAVAILABLE' }
    );
  }
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

// Each CLI needs a different incantation to run non-interactively from a
// server process. Get it wrong and the CLI either hangs waiting for a TTY or
// exits with "Error: stdin is not a terminal". Mirrors `runner.js` /
// `agentCliSpawning.js` so the writers-room path agrees with how PortOS
// already spawns these CLIs everywhere else.
function buildCliInvocation(provider, model) {
  const baseArgs = [...(provider.args || [])];
  if (provider.headlessArgs?.length) baseArgs.push(...provider.headlessArgs);

  switch (provider.id) {
    case 'gemini-cli': {
      const args = [...baseArgs];
      if (!args.includes('--output-format') && !args.includes('-o')) {
        args.push('--output-format', 'text');
      }
      if (model) args.push('--model', model);
      return { args, promptViaStdin: false };
    }
    case 'codex': {
      // `codex exec -` reads the prompt from stdin. Without `exec` codex
      // launches its REPL and bails with "Error: stdin is not a terminal".
      const args = [...baseArgs, 'exec'];
      if (model) args.push('--model', model);
      args.push('-');
      return { args, promptViaStdin: true };
    }
    case 'claude-code':
    case 'claude-code-bedrock': {
      const args = [...baseArgs, '-p', '-'];
      if (model) args.push('--model', model);
      return { args, promptViaStdin: true };
    }
    default: {
      const args = [...baseArgs];
      if (model) args.push('--model', model);
      return { args, promptViaStdin: true };
    }
  }
}

function callCliProvider(provider, model, prompt) {
  return new Promise((resolve, reject) => {
    const { args, promptViaStdin } = buildCliInvocation(provider, model);
    // gemini-cli takes the prompt as a flag because its non-interactive mode
    // requires `--prompt` plus stdio: ['ignore', ...]. Every other CLI accepts
    // the prompt on stdin, which dodges argv ceilings on long drafts.
    if (!promptViaStdin) args.push('--prompt', prompt);
    const child = spawn(provider.command, args, {
      env: (() => { const e = { ...process.env, ...provider.envVars }; delete e.CLAUDECODE; return e; })(),
      stdio: [promptViaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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
      // Tail the output rather than head — CLI banners/transcripts come first
      // and the actual error/stack lives at the end. 500 chars of header was
      // hiding real failures (e.g. provider auth errors) under a Codex banner.
      else reject(new Error(`CLI exited with code ${code}${output ? ': ' + output.slice(-2000) : ''}`));
    });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
    if (promptViaStdin) child.stdin.end(prompt);
  });
}

async function callAI(stageName, variables, temperature) {
  const stage = getStage(stageName);
  const provider = await resolveProviderForStage(stage);
  const prompt = await buildPrompt(stageName, variables);
  let model = resolveModel(provider, stage?.model);
  if (provider.id === 'gemini-cli' && !model) {
    model = provider.lightModel || 'gemini-2.5-flash';
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
  characters: (raw) => {
    const parsed = extractJson(raw);
    const list = Array.isArray(parsed.characters) ? parsed.characters : [];
    return {
      characters: list
        .filter((c) => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim())
        .map((c) => ({
          name: c.name.trim(),
          aliases: Array.isArray(c.aliases) ? c.aliases.filter((a) => typeof a === 'string') : [],
          role: typeof c.role === 'string' ? c.role : '',
          physicalDescription: typeof c.physicalDescription === 'string' ? c.physicalDescription : '',
          personality: typeof c.personality === 'string' ? c.personality : '',
          background: typeof c.background === 'string' ? c.background : '',
          firstAppearance: typeof c.firstAppearance === 'string' ? c.firstAppearance : null,
          evidence: Array.isArray(c.evidence) ? c.evidence.filter((e) => typeof e === 'string') : [],
          missingFromProse: Array.isArray(c.missingFromProse) ? c.missingFromProse.filter((m) => typeof m === 'string') : [],
        })),
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
  settings: (raw) => {
    const parsed = extractJson(raw);
    const list = Array.isArray(parsed.settings) ? parsed.settings : [];
    return {
      settings: list
        .filter((s) => s && typeof s === 'object' && (typeof s.slugline === 'string' || typeof s.name === 'string'))
        .map((s) => ({
          slugline: typeof s.slugline === 'string' ? s.slugline.trim() : '',
          name: typeof s.name === 'string' ? s.name.trim() : '',
          description: typeof s.description === 'string' ? s.description : '',
          palette: typeof s.palette === 'string' ? s.palette : '',
          era: typeof s.era === 'string' ? s.era : '',
          weather: typeof s.weather === 'string' ? s.weather : '',
          recurringDetails: typeof s.recurringDetails === 'string' ? s.recurringDetails : '',
          firstAppearance: typeof s.firstAppearance === 'string' ? s.firstAppearance : null,
          evidence: Array.isArray(s.evidence) ? s.evidence.filter((e) => typeof e === 'string') : [],
          missingFromProse: Array.isArray(s.missingFromProse) ? s.missingFromProse.filter((m) => typeof m === 'string') : [],
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
    .filter(isValidAnalysisId);
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
  if (!isValidAnalysisId(id)) throw badRequest('Invalid analysis id');
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
  if (!isValidAnalysisId(id)) throw badRequest('Invalid analysis id');
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

// Walk every wr-analysis-<uuid>.json file in a work's analysis dir, group by
// kind, keep the latest per kind (by completedAt|createdAt), rewrite as
// <kind>.json, and delete the legacy files. Idempotent — once a work has
// been migrated the dir contains only <kind>.json so this is a noop.
async function migrateLegacyAnalyses(workId) {
  const dir = analysisDir(workId);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const legacy = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .filter((id) => LEGACY_ANALYSIS_ID_RE.test(id));
  if (legacy.length === 0) return 0;
  const loaded = (await Promise.all(legacy.map(async (id) => {
    const path = join(dir, `${id}.json`);
    const content = await readFile(path, 'utf-8').catch(() => null);
    if (content === null) return null;
    const parsed = safeJSONParse(content, null, { allowArray: false, logError: true, context: path });
    return parsed ? { id, snapshot: parsed } : null;
  }))).filter(Boolean);

  const latestPerKind = new Map();
  for (const { snapshot } of loaded) {
    if (!ANALYSIS_KINDS.includes(snapshot.kind)) continue;
    const ts = snapshot.completedAt || snapshot.createdAt || '';
    const prev = latestPerKind.get(snapshot.kind);
    if (!prev || ts > prev.ts) latestPerKind.set(snapshot.kind, { snapshot, ts });
  }

  for (const [kind, { snapshot }] of latestPerKind) {
    await saveAnalysis(workId, { ...snapshot, id: kind });
  }
  await Promise.all(legacy.map((id) => rm(join(dir, `${id}.json`)).catch(() => {})));
  return legacy.length;
}

/**
 * Boot-time housekeeping for analyses:
 *   1. Migrate any legacy wr-analysis-<uuid>.json snapshots into the per-kind
 *      layout (one snapshot per kind, file named <kind>.json).
 *   2. Mark any `running` snapshots as `failed` — a server restart kills
 *      in-flight LLM calls but the pre-call snapshot is already on disk, so
 *      without this the UI would spin forever on a phantom row.
 * Idempotent; called fire-and-forget at boot.
 */
export async function recoverStuckAnalyses() {
  const worksRoot = join(root(), 'works');
  const workEntries = await readdir(worksRoot, { withFileTypes: true }).catch(() => []);
  let migrated = 0;
  let recovered = 0;
  await Promise.all(
    workEntries
      .filter((e) => e.isDirectory())
      .map(async (entry) => {
        migrated += await migrateLegacyAnalyses(entry.name).catch(() => 0);
        const ids = await listAnalysisIds(entry.name).catch(() => []);
        await Promise.all(ids.map(async (id) => {
          const a = await loadAnalysis(entry.name, id);
          if (a?.status !== 'running') return;
          await saveAnalysis(entry.name, {
            ...a,
            status: 'failed',
            error: 'Server restarted while this analysis was running',
            completedAt: nowIso(),
          });
          recovered += 1;
        }));
      })
  );
  if (migrated > 0) console.log(`📝 wr: migrated ${migrated} legacy analysis file(s) to per-kind layout`);
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
  const id = kind;
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
    // Strip down each bible to the fields the prompts care about — no ids,
    // timestamps, or source markers. Same shape goes to both the bible's own
    // re-extraction (preserve-user-edits) AND to script (Adapt) so it can
    // cite canonical names + descriptions in visualPrompt fields.
    const trimCharacter = (c) => ({
      name: c.name,
      aliases: c.aliases,
      role: c.role,
      physicalDescription: c.physicalDescription,
      personality: c.personality,
      background: c.background,
    });
    const trimSetting = (s) => ({
      name: s.name,
      slugline: s.slugline,
      description: s.description,
      palette: s.palette,
      era: s.era,
      weather: s.weather,
      recurringDetails: s.recurringDetails,
    });
    if (kind === 'characters' || kind === 'script') {
      const existing = await listCharacters(workId);
      variables.existingCharactersJson = JSON.stringify(existing.map(trimCharacter), null, 2);
    }
    if (kind === 'settings' || kind === 'script') {
      const existing = await listSettings(workId);
      variables.existingSettingsJson = JSON.stringify(existing.map(trimSetting), null, 2);
    }

    const temperature = kind === 'format' ? 0.2 : 0.4;
    const { content, model: usedModel, providerId: usedProvider } = await callAI(stage, variables, temperature);
    const result = SHAPERS[kind](content);
    let mergedProfiles = null;
    if (kind === 'characters') {
      mergedProfiles = await mergeExtractedCharacters(workId, result.characters || []);
    } else if (kind === 'settings') {
      mergedProfiles = await mergeExtractedSettings(workId, result.settings || []);
    }
    const finished = {
      ...baseSnapshot,
      status: 'succeeded',
      providerId: usedProvider,
      model: usedModel,
      result: mergedProfiles
        ? { ...result, mergedProfiles }
        : result,
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
