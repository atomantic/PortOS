import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinPlatform } from '../lib/testHelper.js';

const probe = vi.hoisted(() => ({ probeOpenAiModels: vi.fn() }));
vi.mock('../lib/openAiModelsProbe.js', () => probe);

const pathLookup = vi.hoisted(() => ({
  findCommandOnPath: vi.fn(() => null),
  safeChildProcessEnv: (extra = {}) => ({ ...extra }),
  safeChildProcessOptions: (opts = {}) => opts,
}));
vi.mock('../lib/processEnv.js', () => pathLookup);

const streaming = vi.hoisted(() => ({ runStreamingCommand: vi.fn(async () => ({ success: true })) }));
vi.mock('../lib/streamingSpawn.js', () => streaming);

const commands = vi.hoisted(() => ({ commandExists: vi.fn(async () => true) }));
vi.mock('../lib/commandExists.js', () => commands);

// The three managers this module delegates to for the runtimes PortOS already
// knew how to install. Mocked so the suite never touches Homebrew or a daemon.
const llama = vi.hoisted(() => ({ installLlamaServer: vi.fn(async () => ({ success: true })) }));
vi.mock('./llamaServerManager.js', () => llama);
const localLlm = vi.hoisted(() => ({
  installBackend: vi.fn(async () => ({ success: true })),
  controlOllamaServer: vi.fn(async () => ({ success: true })),
}));
vi.mock('./localLlm.js', () => localLlm);
vi.mock('./lmStudioManager.js', () => ({ isAppInstalled: () => false }));
// MTPLX's model cache — this module reads it directly (the checklist's refusals
// and its `pull-start` download button are phrased for THIS surface, so the
// reading happens here rather than inside the manager).
const mtplxCache = vi.hoisted(() => ({ listMtplxCachedModels: vi.fn() }));
// PARTIAL mock: only the subprocess call is faked. `describeMtplxCache` and
// `pickMtplxCachedModel` are pure classifiers of that output, and stubbing them
// would let a wrong reading of a real cache listing pass here.
vi.mock('../lib/mtplxModels.js', async (importOriginal) => ({ ...(await importOriginal()), ...mtplxCache }));
// The install and the launch itself are delegated to the PM2-backed manager
// (`portos-mtplx`) — its Homebrew/pip install and `mtplx serve` launch line are
// covered in `mtplxServerManager.test.js`. This suite asserts the delegation.
const mtplx = vi.hoisted(() => ({
  installMtplx: vi.fn(async () => ({ success: true })),
  startMtplxServer: vi.fn(async () => ({ success: true, endpoint: 'http://127.0.0.1:8000/v1' })),
  MTPLX_UNSUPPORTED_REASON: 'MTPLX runs only on macOS with Apple Silicon.',
}));
vi.mock('./mtplxServerManager.js', () => mtplx);
// The vLLM compose project's clone / build / prepare / start. Mocked so this
// suite asserts what the REGISTRY does — offers the action, refuses the wrong
// one, delegates — while the manager's own suite covers what it does on disk.
const vllmManager = vi.hoisted(() => ({
  readVllmQwenSetupState: vi.fn(async () => 'ready'),
  provisionVllmQwenProject: vi.fn(async () => ({ success: true })),
  startVllmQwenProject: vi.fn(async () => ({ success: true })),
}));
vi.mock('./vllmQwenManager.js', () => vllmManager);
// The SGLang project on disk, and the CUDA probe its start row consults BEFORE
// docker — mocked so no assertion depends on the developer's actual GPU.
const sglangProject = vi.hoisted(() => ({
  inspectSglangQwenProject: vi.fn(),
  sglangStartBlockedReason: vi.fn(() => null),
}));
vi.mock('../lib/sglangQwenProject.js', () => sglangProject);
const cuda = vi.hoisted(() => ({ getCudaCapability: vi.fn() }));
vi.mock('../lib/cudaCapability.js', () => cuda);

import { describeRuntimeSetup, readRuntimeWeights, runLocalRuntimeSetup, SETUP_ACTIONS, SETUP_RUNTIME_KINDS } from './localRuntimeSetup.js';

const unreachable = { reachable: false, models: null, error: 'ECONNREFUSED' };
const reachable = (models = ['mtplx']) => ({ reachable: true, models, error: null });

const cachedModels = (models) => ({ models, error: null });

const preparedSglangProject = { dir: '/home/example/sglang-qwen38', hasProject: true, composeFile: 'docker-compose.yml', hasWeights: true, weightsRoot: '/home/example/sglang-qwen38/hf-cache/hub' };

beforeEach(() => {
  sglangProject.inspectSglangQwenProject.mockResolvedValue(preparedSglangProject);
  sglangProject.sglangStartBlockedReason.mockReturnValue(null);
  // Default to the verified Hopper cell; the hardware cases override it.
  cuda.getCudaCapability.mockResolvedValue({ status: 'available', gpus: [{ name: 'NVIDIA H200', computeCap: '9.0', vramGb: 141 }] });
  // Implementations AND return values (not just call records) survive
  // `clearAllMocks`, so a probe implementation left over from an earlier test
  // would drive this module's poll loop for its full timeout.
  probe.probeOpenAiModels.mockReset();
  vllmManager.readVllmQwenSetupState.mockResolvedValue('ready');
  vllmManager.provisionVllmQwenProject.mockResolvedValue({ success: true });
  vllmManager.startVllmQwenProject.mockResolvedValue({ success: true });
  mtplxCache.listMtplxCachedModels.mockResolvedValue(cachedModels([{ repo_id: 'Example/MTP-Model', validation: { ok: true } }]));
  mtplx.installMtplx.mockResolvedValue({ success: true });
  mtplx.startMtplxServer.mockResolvedValue({ success: true, endpoint: 'http://127.0.0.1:8000/v1' });
});

afterEach(() => {
  vi.clearAllMocks();
  pathLookup.findCommandOnPath.mockReturnValue(null);
  commands.commandExists.mockResolvedValue(true);
  streaming.runStreamingCommand.mockResolvedValue({ success: true });
});

describe('describeRuntimeSetup', () => {
  it('covers every runtime the readiness checklist can report', () => {
    expect([...SETUP_RUNTIME_KINDS].sort()).toEqual(['llama', 'lmstudio', 'mtplx', 'ollama', 'sglang', 'slotstream', 'vllm']);
  });

  it('offers install AND start when nothing is there yet', () => {
    const restore = pinPlatform('darwin');
    expect(describeRuntimeSetup('mtplx', { installed: false, running: false })).toEqual({
      runtime: 'mtplx',
      label: 'MTPLX',
      action: 'install-start',
      actionLabel: 'Install & start MTPLX',
      provisions: false,
      blockedReason: null,
    });
    restore();
  });

  it('offers only a start once the runtime is installed', () => {
    const restore = pinPlatform('darwin');
    expect(describeRuntimeSetup('mtplx', { installed: true, running: false })).toMatchObject({
      action: 'start',
      actionLabel: 'Start MTPLX',
    });
    restore();
  });

  it('offers the DOWNLOAD, not a start, when the installed runtime has no weights', () => {
    // The catch-22 this exists to end: "installed ✓ / not responding — press
    // Start", where Start could only ever answer "no model weights are cached".
    const restore = pinPlatform('darwin');
    for (const weights of ['empty', 'partial']) {
      expect(describeRuntimeSetup('mtplx', { installed: true, running: false, weights })).toMatchObject({
        action: 'pull-start',
        actionLabel: 'Download the default model & start MTPLX',
      });
    }
    restore();
  });

  it('keeps a plain start when the cache is READY or unreadable', () => {
    const restore = pinPlatform('darwin');
    // Weights are already there — nothing to download.
    expect(describeRuntimeSetup('mtplx', { installed: true, running: false, weights: 'ready' })).toMatchObject({ action: 'start' });
    // Unreadable is not empty: a start that would have worked must not be
    // turned into a multi-gigabyte download.
    expect(describeRuntimeSetup('mtplx', { installed: true, running: false, weights: 'unknown' })).toMatchObject({ action: 'start' });
    restore();
  });

  it('never offers a download for a runtime with no pull step', () => {
    // Ollama's weights come from the Models → LLMs page, so an empty cache
    // there must not conjure a button this module cannot honour.
    expect(describeRuntimeSetup('ollama', { installed: true, running: false, weights: 'empty' }))
      .toMatchObject({ action: 'start' });
  });

  it('offers nothing once the daemon is installed and up — the model is the user\'s choice', () => {
    const restore = pinPlatform('darwin');
    // A running daemon serving the wrong alias is the remaining unmet check,
    // and PortOS will not pick (or download) a checkpoint for the user.
    expect(describeRuntimeSetup('mtplx', { installed: true, running: true })).toBeNull();
    restore();
  });

  it('names the reason instead of a button on an unsupported host', () => {
    const restore = pinPlatform('linux');
    expect(describeRuntimeSetup('mtplx', { installed: false, running: false })).toMatchObject({
      action: null,
      blockedReason: expect.stringMatching(/only on macOS/),
    });
    restore();
  });

  it('stops at the install for llama.cpp, which cannot start without weights', () => {
    // `start: null` — llama-server takes a required model path, so an installed
    // but stopped llama.cpp gets no button at all.
    expect(describeRuntimeSetup('llama', { installed: false, running: false })).toMatchObject({ action: 'install' });
    expect(describeRuntimeSetup('llama', { installed: true, running: false })).toBeNull();
  });

  it('returns null for a runtime it has no row for', () => {
    expect(describeRuntimeSetup('orcarouter', { installed: false, running: false })).toBeNull();
    expect(describeRuntimeSetup(undefined, { installed: false, running: false })).toBeNull();
  });
});

describe('runLocalRuntimeSetup', () => {
  it('does nothing when the endpoint already answers — on ANY platform', async () => {
    // Pinned to a platform this runtime cannot be installed on: a daemon that
    // answers is running, and the macOS-only gate must not turn that into
    // "MTPLX runs only on macOS". (Left unpinned this passed on a macOS dev box
    // and failed on the Linux CI runner, which is how the ordering bug surfaced.)
    const restore = pinPlatform('linux');
    probe.probeOpenAiModels.mockResolvedValueOnce(reachable());

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(result).toMatchObject({ success: true, message: expect.stringMatching(/already running/) });
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
  });

  it('delegates the MTPLX install to its PM2-backed manager', async () => {
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(mtplx.installMtplx).toHaveBeenCalled();
    // Nothing about MTPLX is installed by a command this module composes — which
    // is what keeps upstream's privileged `mtplx max --install` fan-control
    // helper out of every PortOS path.
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
  });

  it('stops at the install failure rather than starting a daemon that is not there', async () => {
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    mtplx.installMtplx.mockResolvedValue({ success: false, error: 'exit 1: no such formula' });
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/no such formula/) });
    expect(mtplx.startMtplxServer).not.toHaveBeenCalled();
  });

  it('refuses a host that cannot run the runtime at all', async () => {
    probe.probeOpenAiModels.mockResolvedValueOnce(unreachable);
    const restore = pinPlatform('win32');
    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/only on macOS/) });
  });

  it('skips the start step when the install already brought the daemon up', async () => {
    // Ollama's Homebrew service starts on install. Launching a second copy onto
    // the same port is the failure this re-probe exists to prevent.
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)      // pre-flight
      .mockResolvedValueOnce(reachable([]))    // after install
      .mockResolvedValueOnce(reachable(['qwen3']));

    const result = await runLocalRuntimeSetup('ollama', { endpoint: 'http://localhost:11434/v1' });

    expect(localLlm.installBackend).toHaveBeenCalledWith('ollama', expect.any(Function));
    expect(localLlm.controlOllamaServer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, message: expect.stringContaining('qwen3') });
  });

  it('starts an installed-but-stopped Ollama', async () => {
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/ollama');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['qwen3']));

    const result = await runLocalRuntimeSetup('ollama', { endpoint: 'http://localhost:11434/v1' });

    expect(localLlm.installBackend).not.toHaveBeenCalled();
    expect(localLlm.controlOllamaServer).toHaveBeenCalledWith('start');
    expect(result.success).toBe(true);
  });

  it('reports the install as done for llama.cpp and hands the model choice back', async () => {
    probe.probeOpenAiModels.mockResolvedValue(unreachable);

    const result = await runLocalRuntimeSetup('llama', { endpoint: 'http://127.0.0.1:8080/v1' });

    expect(llama.installLlamaServer).toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, message: expect.stringMatching(/Models → LLMs/) });
  });

  it('stops after the install when the modal was closed', async () => {
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', {
      endpoint: 'http://127.0.0.1:8000/v1',
      isCancelled: () => true,
    });
    restore();

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/Cancelled/) });
  });

  it('starts MTPLX on the port the PROVIDER points at, not a hard-coded 8000', async () => {
    // A user who moved MTPLX to 8010 would otherwise get a second server on
    // 8000 that nothing talks to.
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)           // pre-flight
      .mockResolvedValueOnce(unreachable)           // after install
      .mockResolvedValueOnce(reachable(['mtplx'])); // final confirmation
    mtplx.startMtplxServer.mockResolvedValue({ success: true, endpoint: 'http://127.0.0.1:8010/v1' });
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8010/v1' });
    restore();

    expect(mtplx.startMtplxServer).toHaveBeenCalledWith(expect.objectContaining({ port: 8010 }));
    expect(result).toMatchObject({ success: true, message: expect.stringContaining('http://127.0.0.1:8010/v1') });
  });

  it('waits out a cold model load rather than the launcher\'s short beat', async () => {
    // This flow's contract is "the endpoint answers when the button finishes",
    // so it must not inherit the LLMs-page budget that hands back a still-loading
    // server and lets a status poll finish the story.
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['mtplx']));
    const restore = pinPlatform('darwin');

    await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    const [{ waitMs }] = mtplx.startMtplxServer.mock.calls[0];
    expect(waitMs).toBeGreaterThanOrEqual(60_000);
  });

  it('surfaces the manager\'s refusal instead of a bare failure', async () => {
    // e.g. an empty MTPLX cache, which names the download button that fixes it.
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    mtplx.startMtplxServer.mockRejectedValue(new Error('MTPLX has no model weights cached — use "Download default checkpoint"'));
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Download default checkpoint') });
  });

  it('downloads the default checkpoint and then starts, but ONLY for `pull-start`', async () => {
    // The other half of the fix: the button the checklist now offers actually
    // fetches the weights, so the user is not sent to a terminal.
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    // The cache is read by the START step, which runs AFTER the pull — so what
    // it reports here is what the download just landed.
    mtplxCache.listMtplxCachedModels
      .mockResolvedValueOnce(cachedModels([{ repo_id: 'Example/Fresh', validation: { ok: true } }]));
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['mtplx']));
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1', action: 'pull-start' });
    restore();

    expect(streaming.runStreamingCommand).toHaveBeenCalledWith(
      '/opt/homebrew/bin/mtplx', ['pull'], expect.any(Function), expect.objectContaining({ splitRe: expect.any(RegExp) }),
    );
    // The checkpoint the pull just landed is handed to the manager, so it does
    // not walk the same cache a second time for one start.
    expect(mtplx.startMtplxServer).toHaveBeenCalledWith(expect.objectContaining({ port: 8000, model: 'Example/Fresh' }));
    expect(result.success).toBe(true);
  });

  it('never downloads weights behind an explicit plain start', async () => {
    // A multi-gigabyte download is a decision; only the action that says so may
    // spend it. A `start` names the download BUTTON in prose and spends nothing.
    mtplxCache.listMtplxCachedModels.mockResolvedValue(cachedModels([]));
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1', action: 'start' });
    restore();

    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
    expect(mtplx.startMtplxServer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Download the default model') });
    // Never a terminal command as the remedy (PRD NR-9).
    expect(result.error).not.toMatch(/terminal/);
  });

  it('resolves an ABSENT action to whatever the checklist is currently offering', async () => {
    // A client built before `pull-start` existed sends no action — but it still
    // renders THIS server's button label, so on an empty cache the user clicked
    // “Download the default model & start MTPLX”. Defaulting to a start would
    // answer that click with the exact no-weights dead end the action removes.
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    mtplxCache.listMtplxCachedModels
      .mockResolvedValueOnce(cachedModels([]))
      .mockResolvedValueOnce(cachedModels([{ repo_id: 'Example/Fresh', validation: { ok: true } }]));
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['mtplx']));
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(streaming.runStreamingCommand.mock.calls[0][1]).toEqual(['pull']);
    expect(result.success).toBe(true);
  });

  it('resolves an ABSENT action to a plain start when the cache can serve', async () => {
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['mtplx']));
    const restore = pinPlatform('darwin');

    await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
    expect(mtplx.startMtplxServer).toHaveBeenCalled();
  });

  it('refuses `pull-start` for a runtime with no pull step BEFORE installing anything', async () => {
    // Reached after the route validated only membership in the global action
    // list. Refusing late would run Ollama's install on the way to the refusal,
    // and llama.cpp (`start: null`) would return its install-succeeded message
    // without ever refusing at all.
    pathLookup.findCommandOnPath.mockReturnValue(null);
    probe.probeOpenAiModels.mockResolvedValue(unreachable);

    for (const kind of ['ollama', 'llama']) {
      const result = await runLocalRuntimeSetup(kind, { endpoint: 'http://127.0.0.1:11434/v1', action: 'pull-start' });
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/cannot download model weights/) });
    }
    expect(localLlm.installBackend).not.toHaveBeenCalled();
    expect(llama.installLlamaServer).not.toHaveBeenCalled();
  });

  it('hands the download a cancellation hook — the setup lock is held until it settles', async () => {
    // The route holds its single-setup lock until this promise resolves, and a
    // weights pull can run for hours. Without a hook the child ignores a closed
    // modal, so the download keeps going AND every other runtime's setup button
    // is refused for the rest of it.
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['mtplx']));
    const isCancelled = () => false;
    const restore = pinPlatform('darwin');

    await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1', action: 'pull-start', isCancelled });
    restore();

    expect(streaming.runStreamingCommand.mock.calls[0][3]).toMatchObject({ isCancelled });
  });

  it('reads no model cache for a runtime that has none', async () => {
    // `readRuntimeWeights` is what keeps the readiness poll from spending a
    // subprocess per non-MTPLX runtime.
    await expect(readRuntimeWeights('ollama')).resolves.toBe('unknown');
    await expect(readRuntimeWeights('nonsense')).resolves.toBe('unknown');
    expect(mtplxCache.listMtplxCachedModels).not.toHaveBeenCalled();
  });

  it('stops at a failed download rather than starting a server that cannot serve', async () => {
    streaming.runStreamingCommand.mockResolvedValue({ success: false, error: 'exit 1: connection reset' });
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1', action: 'pull-start' });
    restore();

    expect(mtplx.startMtplxServer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('connection reset') });
  });

  it('announces the cached checkpoint once, not once per layer', async () => {
    // The manager emits this line itself once it has the checkpoint, and both
    // layers stream into the SAME setup modal.
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['mtplx']));
    // Stand in for the real manager's own emit, so the count covers both layers.
    mtplx.startMtplxServer.mockImplementation(async ({ model, onProgress }) => {
      if (model) onProgress(`Serving the cached MTPLX model ${model}.`);
      return { success: true, endpoint: 'http://127.0.0.1:8000/v1' };
    });
    const lines = [];
    const restore = pinPlatform('darwin');

    await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1', emit: (l) => lines.push(l) });
    restore();

    expect(lines.filter((l) => /Serving the cached MTPLX model/.test(l))).toHaveLength(1);
  });

  it('exposes every action the route may accept', () => {
    expect([...SETUP_ACTIONS].sort()).toEqual(['install', 'install-start', 'provision-start', 'pull-start', 'start']);
  });

  it('refuses when every cached MTPLX model is an incomplete download', async () => {
    mtplxCache.listMtplxCachedModels.mockResolvedValue(cachedModels([{ repo_id: 'Example/Partial', validation: { ok: false } }]));
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1', action: 'start' });
    restore();

    expect(mtplx.startMtplxServer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/none passed its own file check/) });
  });

  it('starts MTPLX on its own default when the cache cannot be READ', async () => {
    // Unreadable is not empty: blocking here would refuse a start that works.
    mtplxCache.listMtplxCachedModels.mockResolvedValue({ models: null, error: '`mtplx models` timed out' });
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['mtplx']));
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    // No checkpoint to name, so the manager falls through to MTPLX's own default.
    expect(mtplx.startMtplxServer).toHaveBeenCalledWith(expect.objectContaining({ model: null }));
    expect(result.success).toBe(true);
  });

  it('does not start a server when the modal closed while the cache was being read', async () => {
    // The cache lookup is an awaited subprocess, and the caller's cancellation
    // check ran BEFORE it — without a re-check, a closed modal still leaves an
    // MTPLX server running.
    let cancelled = false;
    mtplxCache.listMtplxCachedModels.mockImplementation(async () => {
      cancelled = true; // the user closes the modal while `mtplx models` runs
      return cachedModels([{ repo_id: 'Example/MTP-Model', validation: { ok: true } }]);
    });
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', {
      endpoint: 'http://127.0.0.1:8000/v1',
      isCancelled: () => cancelled,
    });
    restore();

    expect(mtplx.startMtplxServer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/Cancelled/) });
  });

  it('refuses a runtime kind it has no row for', async () => {
    const result = await runLocalRuntimeSetup('made-up', { endpoint: 'http://127.0.0.1:9/v1' });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/no automatic setup/) });
  });
});

describe('vllm — the registry offers it, the manager does it', () => {
  const vllmEndpoint = 'http://127.0.0.1:18020/v1';

  const run = async (action = null) => runLocalRuntimeSetup('vllm', { endpoint: vllmEndpoint, emit: () => {}, action });

  it('is unsupported on darwin, and says where Mac users should go instead', () => {
    const restore = pinPlatform('darwin');
    expect(describeRuntimeSetup('vllm', { installed: false, running: false })).toMatchObject({
      runtime: 'vllm',
      action: null,
      provisions: false,
      blockedReason: expect.stringMatching(/MTPLX or llama.cpp DSpark/),
    });
    restore();
  });

  it('offers a plain start on a Linux/Windows host with a prepared project', () => {
    const restore = pinPlatform('linux');
    expect(describeRuntimeSetup('vllm', { installed: true, running: false, weights: 'ready' })).toMatchObject({
      runtime: 'vllm',
      action: 'start',
      provisions: false,
      blockedReason: null,
    });
    restore();
  });

  it('offers the provisioning button — naming the payload — when nothing is prepared', () => {
    const restore = pinPlatform('linux');
    expect(describeRuntimeSetup('vllm', { installed: true, running: false, weights: 'empty' })).toEqual({
      runtime: 'vllm',
      label: 'vLLM (Qwen3.8-27B)',
      action: 'provision-start',
      actionLabel: 'Clone, build & prepare vLLM (Qwen3.8-27B) (~30 GB), then start',
      // The client renders the download icon and the payload tooltip off THIS
      // flag, so it never re-derives the answer from the action's spelling.
      provisions: true,
      blockedReason: null,
    });
    expect(SETUP_ACTIONS).toContain('provision-start');
    restore();
  });

  it('reads its setup state from the manager, and not at all on an unsupported platform', async () => {
    const linux = pinPlatform('linux');
    vllmManager.readVllmQwenSetupState.mockResolvedValue('empty');
    expect(await readRuntimeWeights('vllm')).toBe('empty');
    linux();

    // Docker is on PATH almost everywhere, so a Mac would otherwise sweep the
    // compose project's cache roots once a minute for a card it cannot have.
    const darwin = pinPlatform('darwin');
    vllmManager.readVllmQwenSetupState.mockClear();
    expect(await readRuntimeWeights('vllm')).toBe('unknown');
    expect(vllmManager.readVllmQwenSetupState).not.toHaveBeenCalled();
    darwin();
  });

  it('provisions then starts, through the manager, for the provision-start action', async () => {
    const restore = pinPlatform('linux');
    pathLookup.findCommandOnPath.mockReturnValue('/usr/bin/docker');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValue(reachable(['qwen3.8-27b']));

    const result = await run('provision-start');

    expect(result.success).toBe(true);
    expect(vllmManager.provisionVllmQwenProject).toHaveBeenCalledTimes(1);
    expect(vllmManager.startVllmQwenProject).toHaveBeenCalledTimes(1);
    restore();
  });

  it('never provisions behind a plain start', async () => {
    const restore = pinPlatform('linux');
    pathLookup.findCommandOnPath.mockReturnValue('/usr/bin/docker');
    vllmManager.readVllmQwenSetupState.mockResolvedValue('ready');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValue(reachable(['qwen3.8-27b']));

    await run(null);

    // The whole point: ~30 GB is never spent on a button that did not say so.
    expect(vllmManager.provisionVllmQwenProject).not.toHaveBeenCalled();
    expect(vllmManager.startVllmQwenProject).toHaveBeenCalledTimes(1);
    restore();
  });

  it('surfaces the manager\'s start refusal verbatim', async () => {
    const restore = pinPlatform('linux');
    pathLookup.findCommandOnPath.mockReturnValue('/usr/bin/docker');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    vllmManager.readVllmQwenSetupState.mockResolvedValue('ready');
    vllmManager.startVllmQwenProject.mockResolvedValue({ success: false, error: 'no Qwen weights are cached yet' });

    const result = await run(null);

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/no Qwen weights are cached/) });
    expect(vllmManager.provisionVllmQwenProject).not.toHaveBeenCalled();
    restore();
  });

  it('refuses a pull-start aimed at vLLM — its provisioning step is not a model download', async () => {
    const restore = pinPlatform('linux');
    pathLookup.findCommandOnPath.mockReturnValue('/usr/bin/docker');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);

    const result = await run('pull-start');

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/cannot download model weights/) });
    expect(vllmManager.provisionVllmQwenProject).not.toHaveBeenCalled();
    restore();
  });

  it('never installs docker, WSL2, or the container toolkit', async () => {
    const restore = pinPlatform('linux');
    pathLookup.findCommandOnPath.mockReturnValue(null); // docker not on PATH
    probe.probeOpenAiModels.mockResolvedValue(unreachable);

    const result = await run('provision-start');

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/does not install this stack/) });
    expect(vllmManager.provisionVllmQwenProject).not.toHaveBeenCalled();
    expect(localLlm.installBackend).not.toHaveBeenCalled();
    restore();
  });
});

describe('sglang — a hardware gate in front of the same never-provision posture', () => {
  const sglangEndpoint = 'http://127.0.0.1:18021/v1';
  const hopper = { status: 'available', gpus: [{ name: 'NVIDIA H200', computeCap: '9.0', vramGb: 141 }] };
  const ampere = { status: 'available', gpus: [{ name: 'NVIDIA GeForce RTX 3090', computeCap: '8.6', vramGb: 24 }] };

  const startOnLinux = async () => {
    pathLookup.findCommandOnPath.mockReturnValue('/usr/bin/docker');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValue(reachable(['qwen3.8-27b']));
    return runLocalRuntimeSetup('sglang', { endpoint: sglangEndpoint, emit: () => {} });
  };

  it('is unsupported on darwin, and says where Mac users should go instead', () => {
    const restore = pinPlatform('darwin');
    expect(describeRuntimeSetup('sglang', { installed: false, running: false })).toMatchObject({
      runtime: 'sglang',
      action: null,
      blockedReason: expect.stringMatching(/MTPLX or llama\.cpp DSpark/),
    });
    restore();
  });

  it('offers a start button on a Linux/Windows host with docker present', () => {
    const restore = pinPlatform('linux');
    expect(describeRuntimeSetup('sglang', { installed: true, running: false })).toMatchObject({
      runtime: 'sglang',
      action: 'start',
      blockedReason: null,
    });
    restore();
  });

  it('brings up an already-prepared compose project — no --profile, in its own directory', async () => {
    const restore = pinPlatform('linux');
    cuda.getCudaCapability.mockResolvedValue(hopper);

    const result = await startOnLinux();

    expect(result.success).toBe(true);
    expect(streaming.runStreamingCommand).toHaveBeenCalledWith(
      'docker',
      ['compose', 'up', '-d'],
      expect.any(Function),
      expect.objectContaining({ cwd: preparedSglangProject.dir }),
    );
    restore();
  });

  it('refuses an Ampere card BEFORE docker, and names the vLLM path instead', async () => {
    // The cookbook has no 3090 cell. Refusing here — not after a `docker compose
    // up` — is what keeps a wrong-hardware host from pulling the image.
    const restore = pinPlatform('linux');
    cuda.getCudaCapability.mockResolvedValue(ampere);

    const result = await startOnLinux();

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/qwen38-rtx3090/) });
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
    expect(sglangProject.inspectSglangQwenProject).not.toHaveBeenCalled();
    restore();
  });

  it('says the probe failed rather than "no GPU" when nvidia-smi would not answer', async () => {
    const restore = pinPlatform('linux');
    cuda.getCudaCapability.mockResolvedValue({ status: 'unknown', gpus: [] });

    const result = await startOnLinux();

    expect(result.error).toMatch(/could not read/i);
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
    restore();
  });

  it('refuses to run compose when the project is not demonstrably prepared', async () => {
    const restore = pinPlatform('linux');
    cuda.getCudaCapability.mockResolvedValue(hopper);
    sglangProject.sglangStartBlockedReason.mockReturnValue('no Qwen weights are cached yet');

    const result = await startOnLinux();

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/no Qwen weights are cached/) });
    // The whole point: a 20 GB pull is never started on the user's behalf.
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
    restore();
  });

  it('never installs docker or the container toolkit', async () => {
    const restore = pinPlatform('linux');
    cuda.getCudaCapability.mockResolvedValue(hopper);
    pathLookup.findCommandOnPath.mockReturnValue(null); // docker not on PATH
    probe.probeOpenAiModels.mockResolvedValue(unreachable);

    const result = await runLocalRuntimeSetup('sglang', { endpoint: sglangEndpoint, emit: () => {} });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/does not install this stack/) });
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
    restore();
  });
});
