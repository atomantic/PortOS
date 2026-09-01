import { describe, it, expect, beforeEach } from 'vitest';
import { pinPlatform } from '../lib/testHelper.js';
import { getProviderReadiness, getProviderReadinessMap, resetProviderReadinessCache } from './providerReadiness.js';

const llamaProvider = (overrides = {}) => ({
  id: 'opencode-llama-tui',
  name: 'OpenCode llama TUI',
  type: 'tui',
  command: 'opencode',
  llamaBacked: true,
  endpoint: 'http://127.0.0.1:5568/v1',
  models: ['dflash'],
  defaultModel: 'dflash',
  ...overrides,
});

const reachable = (models) => async () => ({ reachable: true, models, error: null });
const unreachable = (error = 'connection refused') => async () => ({ reachable: false, models: null, error });

const checkById = (readiness, id) => readiness.checks.find((check) => check.id === id);

beforeEach(() => {
  resetProviderReadinessCache();
});

describe('getProviderReadiness', () => {
  it('returns null for a provider with no local daemon', async () => {
    const readiness = await getProviderReadiness(
      { id: 'claude', command: 'claude', type: 'cli' },
      { findCommand: () => '/usr/bin/claude', probe: unreachable() },
    );
    expect(readiness).toBeNull();
  });

  it('reports nothing — and probes nothing — for an API provider on another machine', async () => {
    // `LM Studio <peer>` matches the `lmstudio` runtime by NAME, so the card
    // used to answer "`lms` is on PortOS's PATH" and "start LM Studio from
    // Models → LLMs" about a server running on someone else's box. An
    // external endpoint is assumed to be set up by whoever runs it.
    let probed = 0;
    let pathScans = 0;
    const readiness = await getProviderReadiness(
      {
        id: 'lmstudio-peer',
        name: 'LM Studio peer',
        type: 'api',
        endpoint: 'http://192.0.2.10:1234/v1',
        defaultModel: 'qwen/qwen3.5-35b-a3b',
      },
      {
        findCommand: () => { pathScans += 1; return '/opt/homebrew/bin/lms'; },
        probe: async () => { probed += 1; return { reachable: false, models: null, error: 'timed out' }; },
        isAppInstalled: () => true,
      },
    );
    expect(readiness).toBeNull();
    expect(probed).toBe(0);
    expect(pathScans).toBe(0);
  });

  it('reports ready when the binary, the server, and the model all check out', async () => {
    const readiness = await getProviderReadiness(llamaProvider(), {
      findCommand: () => '/opt/homebrew/bin/llama-server',
      probe: reachable(['dflash']),
    });
    expect(readiness.kind).toBe('llama');
    expect(readiness.ready).toBe(true);
    expect(readiness.checks.map((check) => check.ok)).toEqual([true, true, true]);
  });

  it('separates missing llama.cpp from its installed, intentionally stopped standby state', async () => {
    const missing = await getProviderReadiness(llamaProvider(), {
      findCommand: () => null,
      probe: unreachable(),
    });
    expect(checkById(missing, 'runtime').ok).toBe(false);
    expect(checkById(missing, 'runtime').fixHint).toMatch(/Install llama\.cpp/);
    expect(missing.standby).toBe(false);

    const stopped = await getProviderReadiness(llamaProvider(), {
      findCommand: () => '/opt/homebrew/bin/llama-server',
      probe: unreachable(),
    });
    expect(checkById(stopped, 'runtime').ok).toBe(true);
    expect(checkById(stopped, 'server').ok).toBe(false);
    expect(checkById(stopped, 'server').fixHint).toMatch(/Start llama\.cpp/);
    expect(stopped.ready).toBe(false);
    expect(stopped.standby).toBe(true);
    expect(stopped.standbyDetail).toMatch(/valid idle state/);

    const missingWeights = await getProviderReadiness(llamaProvider(), {
      findCommand: () => '/opt/homebrew/bin/llama-server',
      probe: unreachable(),
      readWeights: async () => 'empty',
    });
    expect(missingWeights.standby).toBe(false);
  });

  it('counts a responding endpoint as installed even with nothing on PATH', async () => {
    // LM Studio and the Ollama macOS app both serve without putting a CLI on
    // PortOS's PATH — reporting them uninstalled would send the user to install
    // software they are already running.
    const readiness = await getProviderReadiness(llamaProvider({ defaultModel: null }), {
      findCommand: () => null,
      probe: reachable(['dflash']),
    });
    expect(checkById(readiness, 'runtime').ok).toBe(true);
    expect(readiness.ready).toBe(true);
  });

  it('flags a model the running server does not serve, and names what it does serve', async () => {
    const readiness = await getProviderReadiness(llamaProvider({ defaultModel: 'dspark' }), {
      findCommand: () => '/opt/homebrew/bin/llama-server',
      probe: reachable(['dflash', 'qwen3.8-27b']),
    });
    const model = checkById(readiness, 'model');
    expect(model.ok).toBe(false);
    expect(model.detail).toContain('dflash');
    expect(model.servedModels).toEqual(['dflash', 'qwen3.8-27b']);
    expect(model.fixHint).toMatch(/Use the button below/);
    expect(model.fixHint).not.toMatch(/download yourself/i);
    expect(model.fixHint).not.toMatch(/setup docs/i);
    expect(readiness.ready).toBe(false);
    expect(readiness.docsUrl).toBeUndefined();
  });

  // The confusion this prose exists for: the provider lists three model names,
  // the server accepts one, and the checklist read as "llama.cpp does not have
  // the model you installed" — sending the user after a download they already
  // had. llama.cpp serves ONE model per process, under the `--alias` its launch
  // line set, so the other two names were never separate weights.
  it('explains that a one-model-per-process runtime names its model with a launch flag', async () => {
    const readiness = await getProviderReadiness(llamaProvider({ defaultModel: 'qwen3.8-27b-dflash2' }), {
      findCommand: () => '/opt/homebrew/bin/llama-server',
      probe: reachable(['dflash']),
    });
    const model = checkById(readiness, 'model');
    expect(model.detail).toMatch(/serves one model per process/);
    expect(model.detail).toMatch(/--alias/);
    // Both directions are offered: move the provider, or move the server.
    expect(model.renameTo).toBe('qwen3.8-27b-dflash2');
    expect(model.fixHint).toMatch(/nothing needs downloading/);
    expect(model.fixHint).toMatch(/Serve as/);
  });

  // A runtime whose served id comes from the weights it loaded has no label for
  // PortOS to change — offering a rename button there would be a dead end.
  it('offers no rename for a runtime that names its model after the weights', async () => {
    const readiness = await getProviderReadiness(
      {
        id: 'ollama',
        name: 'Ollama',
        type: 'api',
        endpoint: 'http://127.0.0.1:11434/v1',
        defaultModel: 'qwen3:8b',
      },
      { findCommand: () => '/opt/homebrew/bin/ollama', probe: reachable(['llama3:8b']) },
    );
    const model = checkById(readiness, 'model');
    expect(model.ok).toBe(false);
    expect(model.renameTo).toBeNull();
    expect(model.detail).not.toMatch(/serves one model per process/);
    expect(model.fixHint).toMatch(/only accepts/);
  });

  it('calls out a running server with nothing loaded', async () => {
    const readiness = await getProviderReadiness(llamaProvider(), {
      findCommand: () => '/opt/homebrew/bin/llama-server',
      probe: reachable([]),
    });
    const model = checkById(readiness, 'model');
    expect(model.detail).toMatch(/no model loaded/);
    expect(model.servedModels).toEqual([]);
    expect(model.fixHint).toMatch(/Models → LLMs/);
    expect(model.fixHint).not.toMatch(/button below/);
  });

  it('leaves the model check unknown — never failed — while the server is down', async () => {
    const readiness = await getProviderReadiness(llamaProvider(), {
      findCommand: () => '/opt/homebrew/bin/llama-server',
      probe: unreachable(),
    });
    const model = checkById(readiness, 'model');
    expect(model.ok).toBeNull();
    expect(model.fixHint).toBeNull();
    // An unevaluated check is not a pass.
    expect(readiness.ready).toBe(false);
  });

  it('strips the OpenCode namespace before comparing against the served model ids', async () => {
    // `--model llama/dflash` addresses the OpenCode provider entry; the daemon
    // itself only ever reports the bare alias.
    const readiness = await getProviderReadiness(llamaProvider({ defaultModel: 'llama/dflash' }), {
      findCommand: () => '/opt/homebrew/bin/llama-server',
      probe: reachable(['dflash']),
    });
    expect(checkById(readiness, 'model').ok).toBe(true);
  });

  it('omits the model check when the provider pins no model', async () => {
    const readiness = await getProviderReadiness(
      { id: 'opencode-ollama', command: 'opencode', ollamaBacked: true, defaultModel: null },
      { findCommand: () => '/usr/local/bin/ollama', probe: reachable(['llama3:8b']) },
    );
    expect(readiness.checks.map((check) => check.id)).toEqual(['runtime', 'server']);
    expect(readiness.ready).toBe(true);
  });

  it('probes the endpoint the provider configures, not the canonical default', async () => {
    const probed = [];
    await getProviderReadiness(
      llamaProvider({
        endpoint: 'http://127.0.0.1:8090/v1',
        envVars: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { llama: { options: { baseURL: 'http://127.0.0.1:8090/v1' } } } }) },
      }),
      { findCommand: () => null, probe: async (endpoint) => { probed.push(endpoint); return { reachable: false, models: null, error: 'refused' }; } },
    );
    expect(probed).toEqual(['http://127.0.0.1:8090/v1']);
  });

  it('never leaks the resolved binary path', async () => {
    const readiness = await getProviderReadiness(llamaProvider(), {
      findCommand: () => '/Users/someone/bin/llama-server',
      probe: reachable(['dflash']),
    });
    expect(JSON.stringify(readiness)).not.toContain('/Users/someone');
  });

  it('counts an LM Studio app bundle as installed, so the card asks for a START not an install', async () => {
    // The Models → LLMs page already treats the macOS app bundle as installed. When
    // this disagreed, one card rendered 'LM Studio installed' and 'Install LM
    // Studio' two lines apart — and the install was the wrong fix.
    const readiness = await getProviderReadiness(
      { id: 'lmstudio', name: 'LM Studio', type: 'api', endpoint: 'http://localhost:1234/v1' },
      { findCommand: () => null, isAppInstalled: () => true, probe: unreachable() },
    );
    expect(checkById(readiness, 'runtime').ok).toBe(true);
    expect(checkById(readiness, 'server').ok).toBe(false);
    expect(checkById(readiness, 'server').fixHint).toMatch(/Start LM Studio/);
  });

  it('offers a one-click install+start for MTPLX instead of a setup-doc dead end', async () => {
    // The whole point of the setup button: MTPLX has no Models → LLMs page entry,
    // so before it existed the only answer here was "go read the vendor docs".
    const restore = pinPlatform('darwin');
    const readiness = await getProviderReadiness(
      { id: 'opencode-mtplx', command: 'opencode', mtplxBacked: true, defaultModel: 'mtplx' },
      { findCommand: () => null, probe: unreachable() },
    );
    restore();
    expect(readiness.manageUrl).toBeNull();
    // Setup lives in the PortOS UI — the payload never points at a vendor doc.
    expect(readiness.docsUrl).toBeUndefined();
    expect(readiness.setup).toMatchObject({ runtime: 'mtplx', action: 'install-start', blockedReason: null });
    expect(checkById(readiness, 'runtime').fixHint).toMatch(/Install & start MTPLX/);
    expect(checkById(readiness, 'server').fixHint).toMatch(/Install & start MTPLX/);
  });

  it('names the empty model cache on the checklist, and offers the download instead of a start', async () => {
    // The catch-22 as reported: "MTPLX installed ✓ / server not responding —
    // use Start MTPLX, PortOS does this for you", and Start answered "no model
    // weights are cached, so its server exits before it binds a port". The one
    // blocking fact was reachable ONLY by clicking the button it made
    // impossible. It now rides on the checklist itself.
    const restore = pinPlatform('darwin');
    const readiness = await getProviderReadiness(
      { id: 'opencode-mtplx', command: 'opencode', mtplxBacked: true, defaultModel: 'mtplx' },
      { findCommand: () => '/opt/homebrew/bin/mtplx', probe: unreachable(), readWeights: async () => 'empty' },
    );
    restore();

    expect(readiness.setup).toMatchObject({ action: 'pull-start' });
    expect(checkById(readiness, 'server').detail).toMatch(/no model weights cached/);
    expect(checkById(readiness, 'server').fixHint).toMatch(/Download the default model & start MTPLX/);
    // The model check is still unknowable, but no longer says only "cannot be
    // checked until the server responds" — it says what to do about it.
    expect(checkById(readiness, 'model')).toMatchObject({ ok: null, detail: expect.stringMatching(/no model weights cached/) });
    expect(checkById(readiness, 'model').fixHint).toMatch(/Download the default model & start MTPLX/);
  });

  it('distinguishes a half-finished pull from a cache nobody ever pulled into', async () => {
    const restore = pinPlatform('darwin');
    const readiness = await getProviderReadiness(
      { id: 'opencode-mtplx', command: 'opencode', mtplxBacked: true, defaultModel: 'mtplx' },
      { findCommand: () => '/opt/homebrew/bin/mtplx', probe: unreachable(), readWeights: async () => 'partial' },
    );
    restore();
    expect(readiness.setup.action).toBe('pull-start');
    expect(checkById(readiness, 'server').detail).toMatch(/unfinished download/);
  });

  it('keeps a plain start — and says the weights are there — when the cache is ready', async () => {
    const restore = pinPlatform('darwin');
    const readiness = await getProviderReadiness(
      { id: 'opencode-mtplx', command: 'opencode', mtplxBacked: true, defaultModel: 'mtplx' },
      { findCommand: () => '/opt/homebrew/bin/mtplx', probe: unreachable(), readWeights: async () => 'ready' },
    );
    restore();
    expect(readiness.setup.action).toBe('start');
    // The server check must not claim a blocker that isn't one...
    expect(checkById(readiness, 'server').detail).not.toMatch(/weights/);
    // ...while the model check reassures that the download is already done.
    expect(checkById(readiness, 'model').detail).toMatch(/Weights are cached locally/);
  });

  it('never reads a model cache it has no reason to', async () => {
    // A running daemon answers `/v1/models`, which is a better source than its
    // cache; an uninstalled one has no cache to read at all. Spawning `mtplx
    // models` (a directory walk) on either would burn a subprocess per 20s poll
    // for nothing. (A runtime with no readable cache is filtered one level
    // down, by `readRuntimeWeights` — see its test in localRuntimeSetup.)
    const restore = pinPlatform('darwin');
    const reads = [];
    const readWeights = async (kind) => { reads.push(kind); return 'empty'; };
    await getProviderReadiness(
      { id: 'opencode-mtplx', command: 'opencode', mtplxBacked: true, defaultModel: 'mtplx' },
      { findCommand: () => '/opt/homebrew/bin/mtplx', probe: reachable(['mtplx']), readWeights },
    );
    await getProviderReadiness(
      { id: 'opencode-mtplx', command: 'opencode', mtplxBacked: true, defaultModel: 'mtplx' },
      { findCommand: () => null, probe: unreachable(), readWeights },
    );
    restore();
    expect(reads).toEqual([]);
  });

  it('explains why the host cannot run the runtime instead of pointing at a doc', async () => {
    const restore = pinPlatform('linux');
    const readiness = await getProviderReadiness(
      { id: 'opencode-mtplx', command: 'opencode', mtplxBacked: true, defaultModel: 'mtplx' },
      { findCommand: () => null, probe: unreachable() },
    );
    restore();
    // No button — and the checklist says WHY rather than sending the user to a
    // doc that would not help them either.
    expect(readiness.setup.action).toBeNull();
    expect(checkById(readiness, 'runtime').fixHint).toMatch(/only on macOS/);
  });
});

describe('getProviderReadinessMap', () => {
  it('keys only the local-daemon providers, and probes each endpoint once', async () => {
    const probed = [];
    const map = await getProviderReadinessMap(
      [
        llamaProvider(),
        llamaProvider({ id: 'opencode-llama', type: 'cli' }),
        { id: 'claude', command: 'claude', type: 'cli' },
      ],
      {
        findCommand: () => '/opt/homebrew/bin/llama-server',
        probe: async (endpoint) => { probed.push(endpoint); return { reachable: true, models: ['dflash'], error: null }; },
      },
    );
    expect(Object.keys(map).sort()).toEqual(['opencode-llama', 'opencode-llama-tui']);
    // Both llama providers point at the same daemon: one probe for the batch,
    // not one per provider. A stock install ships several providers per
    // endpoint, and this runs on a 20s poll.
    expect(probed).toEqual(['http://127.0.0.1:5568/v1']);
    expect(map['opencode-llama'].ready).toBe(true);
  });

  it('skips disabled providers rather than probing daemons for cards nobody can run', async () => {
    const probed = [];
    const map = await getProviderReadinessMap(
      [llamaProvider({ enabled: false }), llamaProvider({ id: 'on', endpoint: 'http://127.0.0.1:9/v1', enabled: true })],
      { findCommand: () => null, probe: async (endpoint) => { probed.push(endpoint); return { reachable: false, models: null, error: 'refused' }; } },
    );
    expect(Object.keys(map)).toEqual(['on']);
    expect(probed).toEqual(['http://127.0.0.1:9/v1']);
  });

  it('tolerates junk input', async () => {
    await expect(getProviderReadinessMap(null, { findCommand: () => null, probe: unreachable() })).resolves.toEqual({});
  });
});

describe('vLLM — a key-gated container', () => {
  const vllmProvider = (overrides = {}) => ({
    id: 'opencode-vllm-tui',
    name: 'OpenCode vLLM TUI (Qwen3.8-27B)',
    type: 'tui',
    command: 'opencode',
    vllmBacked: true,
    endpoint: 'http://127.0.0.1:18020/v1',
    models: ['qwen3.8-27b'],
    defaultModel: 'qwen3.8-27b',
    ...overrides,
  });

  it('maps the marker to the vLLM runtime at the container endpoint', async () => {
    const readiness = await getProviderReadiness(vllmProvider(), {
      findCommand: () => '/usr/bin/docker',
      probe: reachable(['qwen3.8-27b']),
    });
    expect(readiness).toMatchObject({ kind: 'vllm', endpoint: 'http://127.0.0.1:18020/v1' });
    expect(checkById(readiness, 'model').ok).toBe(true);
  });

  it("hands the provider's key to the probe so a gated container can be listed", async () => {
    const keys = [];
    await getProviderReadiness(vllmProvider({ apiKey: 'vllm-key-example' }), {
      findCommand: () => '/usr/bin/docker',
      probe: async (_endpoint, apiKey) => { keys.push(apiKey); return { reachable: true, models: ['qwen3.8-27b'], error: null }; },
    });
    expect(keys).toEqual(['vllm-key-example']);
  });

  it('calls a 401 a running server, and points at the key rather than at starting it', async () => {
    const readiness = await getProviderReadiness(vllmProvider(), {
      findCommand: () => '/usr/bin/docker',
      probe: async () => ({ reachable: true, models: null, error: 'authentication required' }),
    });
    expect(checkById(readiness, 'server').ok).toBe(true);
    const model = checkById(readiness, 'model');
    expect(model.ok).toBeNull();
    expect(model.detail).toMatch(/paste the server's key/);
  });
});

describe('getProviderReadinessMap batching', () => {
  it(`carries each provider's API key into the batched probe`, async () => {
    // The batch memo used to key on the endpoint alone and forward only that
    // argument, so a key-gated container was probed unauthenticated here while
    // the single-provider path authenticated fine.
    const calls = [];
    const providers = [
      { id: 'a', type: 'tui', command: 'opencode', vllmBacked: true, endpoint: 'http://127.0.0.1:18020/v1', apiKey: 'key-a' },
      { id: 'b', type: 'tui', command: 'opencode', vllmBacked: true, endpoint: 'http://127.0.0.1:18020/v1', apiKey: 'key-b' },
    ];

    await getProviderReadinessMap(providers, {
      findCommand: () => '/usr/bin/docker',
      probe: async (endpoint, apiKey) => { calls.push([endpoint, apiKey]); return { reachable: true, models: ['qwen3.8-27b'], error: null }; },
    });

    expect(calls).toEqual([
      ['http://127.0.0.1:18020/v1', 'key-a'],
      ['http://127.0.0.1:18020/v1', 'key-b'],
    ]);
  });

  it('still collapses two providers sharing one endpoint AND one key into a single probe', async () => {
    let probes = 0;
    const providers = ['a', 'b'].map((id) => ({
      id, type: 'tui', command: 'opencode', llamaBacked: true, endpoint: 'http://127.0.0.1:5568/v1',
    }));

    await getProviderReadinessMap(providers, {
      findCommand: () => '/usr/bin/llama-server',
      probe: async () => { probes += 1; return { reachable: true, models: ['dflash'], error: null }; },
    });

    expect(probes).toBe(1);
  });
});
