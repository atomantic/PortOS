/**
 * Capability tests for local models — the runner.
 *
 * The assessments panel next door answers "how fast is this model here". This
 * one answers the question speed cannot: **can it actually do what its badges
 * claim?** Three tests, each bound to the capability badges the install catalog
 * already shows, each keeping the model's full output:
 *
 *   - `sandbox-repair` (`tools`) — a broken module and its failing test are
 *     copied into a throwaway sandbox and a real OpenCode TUI agent is pointed
 *     at it. The model has to read the files, write a fix to disk, and make the
 *     test pass. The transcript streams to the page while it works.
 *   - `image-analysis` (`vision`) — a fixture image with known contents goes in;
 *     the description is scored against required and bonus keywords.
 *   - `story-outline` (`chat`) — one hero's-journey outline from a fixed
 *     premise, scored on beat coverage and ordering.
 *
 * ## Rules this file exists to honour
 *
 * 1. **No cold-bootstrap LLM calls** (root CLAUDE.md). `getCapabilityTestReport`
 *    touches disk (plus, for Ollama, cached loopback capability probes) and
 *    calls no provider, so it is safe from a poll or a page load.
 *    `runCapabilityTest` is the ONLY path that reaches a model, and it fires
 *    solely from a deliberate click whose gate names the runtime, the model and
 *    the prompt first. There is deliberately **no scheduler and no sweep** here:
 *    a capability run is a manual act.
 * 2. **Verdicts come from disk, never from the transcript.** A model claiming
 *    "I fixed it" scores nothing — the sandbox verdict is the fixture hashes
 *    plus the exit code of a test run PortOS performs itself, after the agent
 *    has stopped.
 * 3. **An unclaimed capability is not a failure.** Applicability is decided in
 *    `lib/modelCapabilityTests.js`; a model with no `vision` badge is skipped on
 *    the image test rather than scored zero on it.
 * 4. **One heavy local job at a time.** A run holds a runtime for minutes and
 *    loads a model into memory, so it takes the same machine-wide claim
 *    assessments and sweeps take. Without it a capability run could execute on
 *    top of an overnight sweep and corrupt its timings.
 */

import { cp, readdir, readFile, rm, stat } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS, ensureDir, sha256File } from '../lib/fileUtils.js';
import { bufferedSpawn } from '../lib/bufferedSpawn.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { claimHeavyLocalJob } from '../lib/heavyJobClaim.js';
import { formatAgentEvent } from '../lib/opencodeStream.js';
import {
  ASSESSABLE_RUNTIMES, LOCAL_RUNTIMES, MANAGED_ASSESSMENT_BACKENDS,
} from '../lib/localProviderRuntime.js';
import {
  CAPABILITY_TESTS, CAPABILITY_TEST_IDS, CAPABILITY_TEST_PROMPTS, SANDBOX_TASK_PROMPT,
  VISION_FIXTURE_KEYWORDS, HEROS_JOURNEY_BEATS,
  applicableTests, getCapabilityTest,
  scoreKeywords, scoreStoryBeats, scoreSandboxRepair, rollUpVerdict,
} from '../lib/modelCapabilityTests.js';
import { listRuntimeModels, runtimeEndpoint, runtimeApiKey } from './localModelAssessments.js';
import { runLocalLlmTest, runEndpointLlmTest } from './localLlmPlayground.js';
import { listProviders } from './providers.js';
import { resolveOpencodeTuiProvider, runOpencodeTask } from './opencodeTask.js';
import { ollamaBadgeCapabilities } from './localLlm.js';
import * as ollamaManager from './ollamaManager.js';
import { indexResults, saveResult, capabilityResultKey, loadResults } from './modelCapabilityTestStore.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/model-tests/', import.meta.url));
const VISION_FIXTURE_SVG = join(FIXTURES, 'vision', 'bicycle-bench.svg');
const SANDBOX_FIXTURE = join(FIXTURES, 'sandbox', 'cart-totals');

/** The three files the sandbox test copies, and what each one is FOR. */
export const SANDBOX_FILES = Object.freeze({
  // The only file the model is allowed to change.
  module: 'cart-totals.mjs',
  // Both of these must come back byte-identical: editing the test into
  // submission is the one way to "pass" without fixing anything.
  test: 'cart-totals.test.mjs',
  data: 'orders.json',
});

/** How PortOS itself checks the sandbox, after the agent has stopped. */
export const SANDBOX_VERIFY_COMMAND = Object.freeze(['node', SANDBOX_FILES.test]);

const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 60 * 1000;
const CHAT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Sandboxes are KEPT after a run — reading the diff is half the value of the
 * test — which means something has to bound them, or a directory the user never
 * looks at grows one copy per run forever. The newest few are what anyone
 * actually opens.
 */
const SANDBOX_KEEP = 20;

// Low but not zero: a deterministic answer makes two runs of the same model
// comparable, while 0 makes some local daemons loop on a repeated phrase.
const TEST_TEMPERATURE = 0.2;

const runtimeLabel = (id) => LOCAL_RUNTIMES[id]?.label || id;

// ---- capabilities -----------------------------------------------------------

/**
 * The badge set a model claims, or `null` when nothing authoritative said.
 *
 * The distinction is the whole point: `[]` means a runtime answered and the
 * model claims nothing (every test is `not-applicable`), while `null` means
 * nobody was asked (every test is `unknown` and stays on offer).
 *
 * Ollama's `/api/tags` carries no capability flags, so `listModels` reports
 * `null` there rather than an empty list — `/api/show` is what actually knows,
 * and it is cached per model, so asking it here stays cheap enough for a read
 * path. Every other runtime either answers in its listing (LM Studio) or is a
 * bare endpoint that reports ids and nothing else.
 */
export async function resolveModelCapabilities(runtime, model) {
  const listed = Array.isArray(model?.capabilities) ? model.capabilities : null;
  if (listed?.length) return listed;
  if (runtime === 'ollama' && model?.id) {
    const raw = await ollamaManager.getModelCapabilities(model.id).catch(() => null);
    // A failed probe is unknown, not "claims nothing".
    return ollamaBadgeCapabilities(raw);
  }
  return listed;
}

/**
 * Whether PortOS can DRIVE the agent tests on a runtime, as opposed to whether a
 * model claims the capability. Surfaced separately so the UI can say "PortOS
 * cannot run this here" rather than implying the model is at fault.
 */
async function agentDriverFor(runtime, providers) {
  const provider = await resolveOpencodeTuiProvider(runtime, providers);
  return provider
    ? { available: true, provider, reason: null }
    : { available: false, provider: null, reason: `no OpenCode TUI provider is configured for ${runtimeLabel(runtime)}` };
}

// ---- fixtures ---------------------------------------------------------------

// Rendered once per process. The fixture is a committed SVG rather than a PNG so
// it stays reviewable in a diff, and rasterizing it here means the bytes a model
// sees are produced the same way on every install.
let visionFixtureCache = null;
// The fixture files never change while the process runs, so their hashes — the
// baseline every sandbox verdict is measured against — are read once.
let fixtureHashCache = null;

export async function loadVisionFixture() {
  if (visionFixtureCache) return visionFixtureCache;
  const png = await sharp(VISION_FIXTURE_SVG).png().toBuffer();
  visionFixtureCache = {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    bytes: png.length,
  };
  return visionFixtureCache;
}

async function sandboxFixtureHashes() {
  if (fixtureHashCache) return fixtureHashCache;
  fixtureHashCache = Object.fromEntries(await Promise.all(
    Object.entries(SANDBOX_FILES).map(async ([role, name]) => [role, await sha256File(join(SANDBOX_FIXTURE, name))]),
  ));
  return fixtureHashCache;
}

/** Test seam: drop the cached fixtures so a suite can re-read them. */
export function __resetFixtureCaches() {
  visionFixtureCache = null;
  fixtureHashCache = null;
}

// ---- run plumbing -----------------------------------------------------------

const progressFrame = (backend, modelId, testId, frame) => ({
  scope: 'capability-test',
  backend,
  modelId,
  testId,
  ...frame,
});

/**
 * Ask the right transport for one bounded generation.
 *
 * A managed backend goes through the playground's provider path (and so lands in
 * `/runs`); a bare daemon is talked to directly, because inventing a provider
 * record for something the user started outside PortOS would put a phantom
 * provider in the run history. Same result shape either way.
 */
async function generate({ backend, modelId, prompt, images, maxTokens, signal }) {
  if (MANAGED_ASSESSMENT_BACKENDS.includes(backend)) {
    return runLocalLlmTest({
      backend, modelId, prompt, images, maxTokens, signal,
      temperature: TEST_TEMPERATURE, timeoutMs: CHAT_TIMEOUT_MS,
    });
  }
  const endpoint = await runtimeEndpoint(backend);
  if (!endpoint) {
    throw new ServerError(`No endpoint is configured for ${runtimeLabel(backend)}`, {
      status: 503, code: 'CAPABILITY_TEST_RUNTIME_UNREACHABLE',
    });
  }
  return runEndpointLlmTest({
    runtime: backend, endpoint, apiKey: await runtimeApiKey(backend),
    modelId, prompt, images, maxTokens, signal,
    temperature: TEST_TEMPERATURE, timeoutMs: CHAT_TIMEOUT_MS,
  });
}

// ---- the three tests --------------------------------------------------------

/**
 * The two generative tests, which differ only in what they send and how the
 * answer is scored. Everything else — the empty-output contract, keeping the
 * text whichever way the run ended — is identical, and was worth having in one
 * place rather than twice.
 */
const CHAT_TESTS = {
  'image-analysis': {
    maxTokens: 700,
    message: (modelId) => `Sending the fixture image to ${modelId}…`,
    images: async () => [(await loadVisionFixture()).dataUrl],
    score: (text) => scoreKeywords(text, VISION_FIXTURE_KEYWORDS),
  },
  'story-outline': {
    // A twelve-beat outline runs close to a thousand tokens; a budget that
    // clipped it would score as missing beats — a scoring bug dressed up as a
    // model failure.
    maxTokens: 2400,
    message: (modelId) => `Asking ${modelId} for a twelve-beat outline…`,
    images: async () => undefined,
    score: (text) => scoreStoryBeats(text, HEROS_JOURNEY_BEATS),
  },
};

async function runChatTest({ backend, modelId, testId, signal, emit }) {
  const spec = CHAT_TESTS[testId];
  const images = await spec.images();
  emit({ event: 'progress', message: spec.message(modelId) });

  const result = await generate({
    backend, modelId, prompt: CAPABILITY_TEST_PROMPTS[testId], images, maxTokens: spec.maxTokens, signal,
  });
  const output = String(result?.text || '');

  // Nothing came back at all: there is no answer to score, so the error IS the
  // result. A run that produced text AND reported an error (a mid-stream
  // timeout) is scored on what it produced, with the error kept beside it.
  if (result?.error && !output.trim()) {
    return { verdict: 'failed', summary: result.error, output, detail: null, error: result.error, timings: result.timings || null };
  }
  const detail = spec.score(output);
  return {
    verdict: detail.verdict,
    summary: detail.summary,
    output,
    detail,
    error: result?.error || null,
    timings: result?.timings || null,
  };
}

/**
 * Delete all but the newest sandboxes. `runId` starts with a base36 timestamp of
 * fixed width, so a plain sort is chronological.
 */
async function pruneSandboxes(root, keep = SANDBOX_KEEP) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const stale = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().slice(0, -keep);
  for (const name of stale) {
    await rm(join(root, name), { recursive: true, force: true }).catch((err) => {
      console.error(`⚠️ Capability tests: could not prune sandbox ${name} — ${err.message}`);
    });
  }
}

/**
 * Sandbox repair: the one test that watches a model work.
 *
 * The sandbox is a fresh copy of the fixture for every run, so a model that
 * mangles the module cannot affect the next run — and the fixture in the repo is
 * never the thing being edited.
 */
async function runSandboxRepair({ backend, modelId, signal, emit, runId, providers }) {
  const driver = await agentDriverFor(backend, providers);
  if (!driver.available) {
    throw new ServerError(driver.reason, { status: 503, code: 'CAPABILITY_TEST_AGENT_UNAVAILABLE' });
  }

  const sandboxRoot = join(PATHS.data, 'model-tests', 'sandboxes');
  const sandbox = join(sandboxRoot, runId);
  await ensureDir(sandbox);
  await cp(SANDBOX_FIXTURE, sandbox, { recursive: true });
  emit({ event: 'progress', message: `Sandbox ready — ${Object.keys(SANDBOX_FILES).length} files copied.` });

  const fixtureHashes = await sandboxFixtureHashes();

  let transcript = '';
  let toolCalls = 0;
  const startedAt = Date.now();

  emit({ event: 'progress', message: `Starting the ${driver.provider.name || 'OpenCode'} agent on ${modelId}…` });
  const agent = await runOpencodeTask({
    provider: driver.provider,
    modelId,
    cwd: sandbox,
    prompt: SANDBOX_TASK_PROMPT,
    timeoutMs: AGENT_TIMEOUT_MS,
    // One parse feeds both the stored transcript and the live view, so the two
    // can never disagree about what the agent did.
    onEvent: (event) => {
      const rendered = formatAgentEvent(event);
      if (!rendered) return;
      if (rendered.toolCall) toolCalls += 1;
      transcript += `${rendered.line}\n`;
      // Watching the loop work is the point of driving a TUI here rather than an
      // in-process tool loop.
      emit({ event: 'output', line: rendered.line });
    },
  });

  // ---- verification: disk only, never the transcript ----
  emit({ event: 'progress', message: 'Agent finished — checking the sandbox on disk…' });

  const hashOf = (name) => sha256File(join(sandbox, name)).catch(() => null);
  const [moduleHash, testHash, dataHash] = await Promise.all([
    hashOf(SANDBOX_FILES.module), hashOf(SANDBOX_FILES.test), hashOf(SANDBOX_FILES.data),
  ]);

  // PortOS runs the test itself rather than believing the agent's own run: the
  // exit code of a command we issued is the only evidence that survives a model
  // reporting a success it did not achieve.
  const verify = await bufferedSpawn(SANDBOX_VERIFY_COMMAND[0], SANDBOX_VERIFY_COMMAND.slice(1), {
    cwd: sandbox,
    // PWD pinned at the call site (#3193). `node` resolves the test path from
    // cwd rather than PWD, so this is belt-and-braces today — but the command is
    // the kind of thing that grows a package runner later, and an inherited PWD
    // pointing at the PortOS checkout is exactly how one ends up verifying the
    // wrong directory.
    env: withSpawnCwdEnv(process.env, sandbox),
    timeoutMs: VERIFY_TIMEOUT_MS,
  });

  const detail = scoreSandboxRepair({
    // A deleted module reads as "never wrote a fix", not as a change.
    moduleChanged: Boolean(moduleHash) && moduleHash !== fixtureHashes.module,
    fixturesIntact: testHash === fixtureHashes.test && dataHash === fixtureHashes.data,
    testsPass: verify.success,
    toolCalls,
  });

  await pruneSandboxes(sandboxRoot);

  return {
    verdict: detail.verdict,
    summary: detail.summary,
    // The test's "output" is what PortOS's own verification run printed — the
    // thing that decided the verdict — with the agent's narration beside it.
    output: verify.stdout || verify.stderr || '',
    transcript,
    detail: {
      ...detail,
      driver: driver.provider.id,
      driverLabel: driver.provider.name || driver.provider.id,
      verifyCommand: SANDBOX_VERIFY_COMMAND.join(' '),
      verifyExitCode: verify.code,
      sandboxPath: sandbox,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    },
    // Recorded even when the verdict already stands on its own: "never wrote a
    // fix" and "never wrote a fix because the CLI was missing" need different
    // responses from the user.
    error: agent.error,
    timings: null,
  };
}

const RUNNERS = {
  'image-analysis': runChatTest,
  'story-outline': runChatTest,
  'sandbox-repair': runSandboxRepair,
};

// ---- public run path --------------------------------------------------------

/**
 * Run ONE capability test against ONE model. The only path here that reaches a
 * provider, and only ever from an explicit user action.
 *
 * @param {object} options
 * @param {string} options.backend assessable runtime id
 * @param {string} options.modelId
 * @param {string} options.testId one of CAPABILITY_TEST_IDS
 * @param {AbortSignal} [options.signal] the client's disconnect
 * @param {(frame: object) => void} [options.onProgress]
 * @param {number} [options.claimTimeoutMs] how long to wait for the machine-wide
 *   heavy-job claim before reporting it busy
 */
export async function runCapabilityTest({ backend, modelId, testId, signal, onProgress, claimTimeoutMs = 0 } = {}) {
  const test = getCapabilityTest(testId);
  if (!test) {
    throw new ServerError(`Unknown capability test: ${testId}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!ASSESSABLE_RUNTIMES.includes(backend)) {
    throw new ServerError(`Unsupported runtime: ${backend}`, { status: 400, code: 'VALIDATION_ERROR' });
  }

  const emit = (frame) => onProgress?.(progressFrame(backend, modelId, testId, frame));
  // A short, sortable id: it names the sandbox directory (and so its prune
  // order) and appears in the log line, so it has to read cleanly and be unique
  // per run.
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  // A run holds the runtime for minutes and loads a model into memory, so it
  // takes the same claim an assessment or a sweep takes. Without it a capability
  // run could execute on top of an overnight sweep and corrupt its timings.
  const claim = await claimHeavyLocalJob({ kind: 'model capability test', id: `${backend}/${modelId}`, timeoutMs: claimTimeoutMs });
  if (!claim.ok) {
    throw new ServerError(claim.message, { status: 409, code: 'HEAVY_LOCAL_JOB_BUSY', context: { holder: claim.holder } });
  }

  console.log(`🧪 Capability tests: ${test.id} on ${backend}/${modelId} (run ${runId})`);
  emit({ event: 'start', message: `${test.label}: starting on ${modelId}…`, runId });

  const startedAt = Date.now();
  let outcome;
  try {
    // The claim wait is bounded but can be long, and it does not observe the
    // abort signal. A cancel that landed while we waited must not turn into a
    // run now that the machine is free.
    if (signal?.aborted) {
      emit({ event: 'complete', cancelled: true, message: `${test.label}: cancelled — nothing recorded` });
      return { backend, modelId, testId: test.id, cancelled: true };
    }
    const providers = test.driver === 'tui' ? await listProviders() : null;
    outcome = await RUNNERS[test.id]({ backend, modelId, testId: test.id, signal, emit, runId, providers });
  } catch (err) {
    // A terminal frame either way, or the page's banner sits on the last
    // progress line forever waiting for a run that already died.
    emit({ event: 'complete', message: `${test.label}: ${err.message}`, verdict: 'failed' });
    throw err;
  } finally {
    await claim.release();
  }

  // A cancelled run recorded as `failed` would be a lie about the model that
  // then needs manually deleting. Report what was gathered; store nothing.
  if (signal?.aborted) {
    console.log(`🧪 Capability tests: ${test.id} on ${backend}/${modelId} cancelled — not recorded`);
    emit({ event: 'complete', cancelled: true, message: `${test.label}: cancelled — nothing recorded` });
    return { ...outcome, backend, modelId, testId: test.id, cancelled: true };
  }

  const record = await saveResult({
    backend,
    modelId,
    testId: test.id,
    runId,
    verdict: outcome.verdict,
    summary: outcome.summary,
    output: outcome.output,
    transcript: outcome.transcript ?? '',
    detail: outcome.detail ?? null,
    error: outcome.error ?? null,
    timings: outcome.timings ?? null,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ranAt: new Date().toISOString(),
  });

  console.log(`🧪 Capability tests: ${test.id} on ${backend}/${modelId} → ${record.verdict} (${record.summary})`);
  emit({ event: 'complete', verdict: record.verdict, message: `${test.label}: ${record.verdict} — ${record.summary}` });
  return record;
}

// ---- read path --------------------------------------------------------------

/**
 * What the matrix needs about one recorded result — everything EXCEPT the model
 * output and the agent transcript.
 *
 * Those two are the bulk of a record (up to ~100 KB each) and are needed only
 * when the drawer opens one pairing. Shipping every stored transcript on every
 * page load would make the report grow with the square of how much testing the
 * user has done, to render a chip that says "passed".
 */
const summarizeResult = (r) => (r ? {
  backend: r.backend,
  modelId: r.modelId,
  testId: r.testId,
  verdict: r.verdict,
  summary: r.summary,
  ranAt: r.ranAt ?? null,
  elapsedMs: r.elapsedMs ?? null,
  detail: r.detail ?? null,
  error: r.error ?? null,
  timings: r.timings ?? null,
} : null);

/** One stored result in full, for the drawer. `null` when nothing is recorded. */
export async function getCapabilityTestResult(backend, modelId, testId) {
  const results = await loadResults();
  return results.find((r) => r?.backend === backend && r?.modelId === modelId && r?.testId === testId) || null;
}

/**
 * Everything the page needs to show what each installed model claims and what it
 * has proved. Disk plus cached loopback capability probes; zero LLM calls.
 */
export async function getCapabilityTestReport() {
  const providers = await listProviders();
  const [{ index, readError }, listed, drivers] = await Promise.all([
    indexResults(),
    Promise.all(ASSESSABLE_RUNTIMES.map(async (runtime) => [runtime, await listRuntimeModels(runtime)]))
      .then(Object.fromEntries),
    Promise.all(ASSESSABLE_RUNTIMES.map(async (runtime) => [runtime, await agentDriverFor(runtime, providers)]))
      .then(Object.fromEntries),
  ]);

  // Capability resolution costs one cached `/api/show` per un-probed Ollama
  // model. Sequentially that is one round trip per model on the page-load path;
  // they are independent, so they go together.
  const offline = Object.fromEntries(ASSESSABLE_RUNTIMES.map((id) => [id, Boolean(listed[id].offline)]));

  const models = (await Promise.all(ASSESSABLE_RUNTIMES.flatMap((runtime) =>
    (listed[runtime].models || []).filter((m) => m?.id).map(async (model) => {
      const capabilities = await resolveModelCapabilities(runtime, model);
      const tests = applicableTests(capabilities).map(({ test, state, missing, reason }) => {
        const stored = index[capabilityResultKey(runtime, model.id, test.id)] || null;
        // The agent driver is a property of the RUNTIME, not of the model, and it
        // can make an otherwise-applicable test unrunnable. Surfaced as its own
        // state so the UI explains "PortOS cannot drive this" rather than
        // implying the model is at fault.
        // Two things can make an otherwise-applicable test unrunnable, and both
        // are properties of the RUNTIME rather than of the model — so they are
        // surfaced as `unavailable` with the reason, never as a failure the
        // model earned. A stopped daemon wins the explanation: starting it is
        // the fix, and the missing agent preset may not even be missing once it
        // is up.
        const runtimeDown = offline[runtime] && state !== 'not-applicable';
        const noDriver = test.driver === 'tui' && state === 'applicable' && !drivers[runtime].available;
        return {
          testId: test.id,
          state: runtimeDown || noDriver ? 'unavailable' : state,
          missing,
          reason: runtimeDown
            ? `${runtimeLabel(runtime)} is not running`
            : (noDriver ? drivers[runtime].reason : reason),
          result: summarizeResult(stored),
        };
      });
      return {
        backend: runtime,
        runtimeLabel: runtimeLabel(runtime),
        // These came off disk rather than from the daemon: installed, but
        // nothing can run against them until the runtime is started.
        offline: Boolean(offline[runtime]),
        // `null` = nothing authoritative reported a badge set. The UI must say
        // "unverified", never render it as an empty badge row.
        capabilities,
        modelId: model.id,
        tests,
        verdict: rollUpVerdict(tests.map((t) => t.result?.verdict).filter(Boolean)),
      };
    })
  ))).filter(Boolean);

  const countTests = (predicate) => models.reduce((acc, m) => acc + m.tests.filter(predicate).length, 0);

  return {
    // Serialized rather than referenced so the client renders one catalog and
    // cannot drift from the gate the server enforces.
    tests: CAPABILITY_TESTS.map((t) => ({ ...t, capabilities: [...t.capabilities], prefers: [...t.prefers] })),
    prompts: { ...CAPABILITY_TEST_PROMPTS, 'sandbox-repair': SANDBOX_TASK_PROMPT },
    models,
    counts: {
      models: models.length,
      applicable: countTests((t) => t.state === 'applicable' || t.state === 'unknown'),
      passed: countTests((t) => t.result?.verdict === 'passed'),
      failed: countTests((t) => t.result?.verdict === 'failed'),
    },
    // Runtimes whose model list could not be read live — distinct from "listed
    // and legitimately empty". `manageUrl` is what makes this actionable rather
    // than just a complaint: for the runtimes PortOS can start, it points at the
    // page that starts them. `recovered` says PortOS listed what is on disk
    // anyway, so the user knows the models below are real and merely unreachable.
    listErrors: ASSESSABLE_RUNTIMES
      .filter((id) => listed[id].error)
      .map((id) => ({
        id,
        label: runtimeLabel(id),
        error: listed[id].error,
        offline: Boolean(listed[id].offline),
        recovered: Array.isArray(listed[id].models) ? listed[id].models.length : 0,
        manageUrl: LOCAL_RUNTIMES[id]?.manageUrl || null,
        docsUrl: LOCAL_RUNTIMES[id]?.docsUrl || null,
      })),
    readError,
  };
}

export { CAPABILITY_TEST_IDS };
