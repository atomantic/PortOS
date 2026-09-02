import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinPlatform } from '../lib/testHelper.js';
import { vllmExtraArgs } from '../lib/qwenAgentParsers.js';

const pathLookup = vi.hoisted(() => ({
  findCommandOnPath: vi.fn(() => null),
  safeChildProcessEnv: (extra = {}) => ({ ...extra }),
  safeChildProcessOptions: (opts = {}) => opts,
}));
vi.mock('../lib/processEnv.js', () => pathLookup);

const streaming = vi.hoisted(() => ({ runStreamingCommand: vi.fn(async () => ({ success: true })) }));
vi.mock('../lib/streamingSpawn.js', () => streaming);

// The compose project on disk. Mocked so the suite never stats a real checkout.
// PARTIAL for the rest of the module: `vllmProjectSetupState` is a pure
// classifier, and stubbing it would let a wrong reading of a real inspection
// pass here.
const project = vi.hoisted(() => ({
  inspectVllmQwenProject: vi.fn(),
  vllmStartBlockedReason: vi.fn(() => null),
  // PortOS's own `.env`, which the real pair reads and writes — mocked so a
  // suite can never be answered by (or write into) the developer's install.
  vllmProjectDirIsSettled: vi.fn(() => false),
  recordVllmProjectDir: vi.fn(async () => {}),
}));
vi.mock('../lib/vllmQwenProject.js', async (importOriginal) => ({ ...(await importOriginal()), ...project }));

// `wsl.exe`. Mocked because the real one answers on the developer's Windows box
// — the placement tests would then assert against THAT machine's distro.
const wsl = vi.hoisted(() => ({ detectWslProjectDir: vi.fn() }));
vi.mock('../lib/wslDistro.js', async (importOriginal) => ({ ...(await importOriginal()), ...wsl }));

// The two side effects: the `.env` write and the provider records the generated
// key lands on. `tryReadFile`/`formatBytes` stay real — they are pure readers.
const files = vi.hoisted(() => ({ atomicWrite: vi.fn(async () => {}), tryReadFile: vi.fn(async () => null) }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({ ...(await importOriginal()), ...files }));

const providers = vi.hoisted(() => ({
  getAllProviders: vi.fn(async () => ({ activeProvider: null, providers: [] })),
  updateProvider: vi.fn(async () => ({})),
}));
vi.mock('./providers.js', () => providers);

import { provisionVllmQwenProject, readVllmQwenSetupState, startVllmQwenProject, VLLM_UPSTREAM_REPO } from './vllmQwenManager.js';

const DIR = '/home/example/qwen-serving';
/** What `wsl.exe` says on a Windows host with an ordinary distro. */
const WSL_DIR = '\\\\wsl.localhost\\Ubuntu\\home\\example\\qwen-serving';
const emptyProject = { dir: DIR, hasProject: false, composeFile: null, hasWeights: null, weightsRoot: null };
const clonedProject = { ...emptyProject, hasProject: true, composeFile: 'docker-compose.yml', hasWeights: false };
const preparedProject = { ...clonedProject, hasWeights: true, weightsRoot: `${DIR}/models` };

/** The docker argv lists, in the order they were run. */
const dockerCalls = () => streaming.runStreamingCommand.mock.calls
  .filter(([cmd]) => cmd === 'docker')
  .map(([, args]) => args.join(' '));

/** A run against a host with nothing cloned yet. */
const stageFreshProject = () => project.inspectVllmQwenProject
  .mockResolvedValueOnce(emptyProject)     // the provisioning step's own look
  .mockResolvedValue(clonedProject);       // the re-read after the clone

const provision = async (lines = []) => provisionVllmQwenProject({
  emit: (line) => lines.push(line),
  isCancelled: () => false,
});

/** Everything the run streamed to the modal. */
const emitted = (lines) => lines.join('\n');

let restorePlatform = () => {};

/** Swap the pinned platform mid-test, releasing the one `beforeEach` set. */
function repin(platform) {
  restorePlatform();
  restorePlatform = pinPlatform(platform);
}

beforeEach(() => {
  restorePlatform = pinPlatform('linux');
  pathLookup.findCommandOnPath.mockImplementation((cmd) => (cmd === 'docker' || cmd === 'git' ? `/usr/bin/${cmd}` : null));
  project.inspectVllmQwenProject.mockResolvedValue(preparedProject);
  project.vllmStartBlockedReason.mockReturnValue(null);
  project.vllmProjectDirIsSettled.mockImplementation(() => Boolean(process.env.VLLM_QWEN_PROJECT_DIR));
  wsl.detectWslProjectDir.mockResolvedValue({ dir: WSL_DIR, distro: 'Ubuntu', home: '\\\\wsl.localhost\\Ubuntu\\home\\example' });
  files.tryReadFile.mockResolvedValue(null);
  providers.getAllProviders.mockResolvedValue({ activeProvider: null, providers: [] });
  streaming.runStreamingCommand.mockResolvedValue({ success: true });
});

afterEach(() => {
  restorePlatform();
  vi.clearAllMocks();
  delete process.env.VLLM_QWEN_PROJECT_DIR;
});

describe('readVllmQwenSetupState', () => {
  it('reports empty when nothing is cloned, and when a checkout was never prepared', async () => {
    project.inspectVllmQwenProject.mockResolvedValue(emptyProject);
    expect(await readVllmQwenSetupState()).toBe('empty');

    project.inspectVllmQwenProject.mockResolvedValue(clonedProject);
    expect(await readVllmQwenSetupState()).toBe('empty');
  });

  it('never reports a cache it could not READ as empty', async () => {
    // The normal Windows shape before VLLM_QWEN_PROJECT_DIR points at the UNC
    // path. Calling this `empty` would offer to re-download ~20 GB that is
    // already on disk.
    project.inspectVllmQwenProject.mockResolvedValue({ ...clonedProject, hasWeights: null });
    expect(await readVllmQwenSetupState()).toBe('unknown');
  });

  it('reports ready for a prepared project', async () => {
    expect(await readVllmQwenSetupState()).toBe('ready');
  });
});

describe('provisionVllmQwenProject', () => {
  it('clones, writes .env, builds, prepares — in that order', async () => {
    stageFreshProject();
    const lines = [];

    const result = await provision(lines);

    expect(result.success).toBe(true);
    expect(streaming.runStreamingCommand).toHaveBeenCalledWith(
      '/usr/bin/git',
      ['clone', VLLM_UPSTREAM_REPO, DIR],
      expect.any(Function),
      expect.objectContaining({ splitRe: expect.any(RegExp) }),
    );
    expect(dockerCalls()).toEqual([
      'version --format {{.Server.Version}}',
      'compose build',
      'compose run --rm prepare',
    ]);
    expect(emitted(lines)).toMatch(/~9\.5 GB/);
  });

  it('writes the tool-parser line every time, and the WSL2 pair only on a WSL2 engine', async () => {
    stageFreshProject();

    await provision();

    const [envPath, contents] = files.atomicWrite.mock.calls[0];
    expect(String(envPath)).toMatch(/[\\/]\.env$/);
    // Without this the agent's first turn is rejected; with `hermes` instead it
    // silently never emits a tool call at all.
    expect(contents).toContain(`EXTRA_ARGS=${vllmExtraArgs()}`);
    expect(contents).toContain('SPEC=dflash2');
    expect(contents).toContain('PREFIX_CACHE=1');
    // Native Linux does not need — and must not be given — the WSL2 pair.
    expect(contents).not.toContain('VLLM_WSL2_ENABLE_PIN_MEMORY');
  });

  it('adds the two mandatory WSL2 variables when Docker Desktop backs it', async () => {
    repin('win32');
    process.env.VLLM_QWEN_PROJECT_DIR = '\\\\wsl.localhost\\example\\home\\example\\qwen-serving';
    stageFreshProject();
    const lines = [];

    await provision(lines);

    const contents = files.atomicWrite.mock.calls[0][1];
    // Both are preconditions for starting at all on WSL2, and each fails in a
    // way that points somewhere other than WSL — a quiet crash-loop and a
    // fake-looking OOM respectively.
    expect(contents).toContain('VLLM_WSL2_ENABLE_PIN_MEMORY=1');
    expect(contents).toContain('PYTORCH_CUDA_ALLOC_CONF=expandable_segments:False');
    // The VM memory ceiling is named before the step it kills, never raised —
    // `wsl --shutdown` would take down this install's own PostgreSQL container.
    expect(emitted(lines)).toMatch(/\.wslconfig/);
  });

  it('keeps every value an existing .env already had, and propagates THAT key', async () => {
    files.tryReadFile.mockImplementation(async (path) => (
      String(path).endsWith('.env') ? 'GPU_UTIL=0.93\nVLLM_API_KEY=operator-chosen-key\n' : null
    ));
    providers.getAllProviders.mockResolvedValue({
      activeProvider: null,
      providers: [
        { id: 'opencode-vllm', vllmBacked: true, apiKey: '' },
        { id: 'opencode-vllm-tui', vllmBacked: true, apiKey: '' },
        { id: 'anthropic', apiKey: 'untouched' },
      ],
    });
    stageFreshProject();
    const lines = [];

    await provision(lines);

    const contents = files.atomicWrite.mock.calls[0][1];
    expect(contents).toContain('GPU_UTIL=0.93');
    // Exactly one VLLM_API_KEY line, and it is the operator's.
    expect(contents.match(/^VLLM_API_KEY=/gm)).toHaveLength(1);
    expect(contents).toContain('VLLM_API_KEY=operator-chosen-key');
    // The key the CONTAINER will read is the one the providers get.
    expect(providers.updateProvider.mock.calls).toEqual([
      ['opencode-vllm', { apiKey: 'operator-chosen-key' }],
      ['opencode-vllm-tui', { apiKey: 'operator-chosen-key' }],
    ]);
    // It is a secret: stored, never streamed to the modal.
    expect(emitted(lines)).not.toContain('operator-chosen-key');
  });

  it('generates a key when the .env has none, and never prints it', async () => {
    providers.getAllProviders.mockResolvedValue({
      activeProvider: null,
      providers: [{ id: 'opencode-vllm-tui', vllmBacked: true, apiKey: '' }],
    });
    stageFreshProject();
    const lines = [];

    await provision(lines);

    const generated = providers.updateProvider.mock.calls[0][1].apiKey;
    expect(generated).toMatch(/^[0-9a-f]{48}$/);
    expect(files.atomicWrite.mock.calls[0][1]).toContain(`VLLM_API_KEY=${generated}`);
    expect(emitted(lines)).not.toContain(generated);
  });

  it('carries on when a provider write fails — the key is in .env either way', async () => {
    providers.getAllProviders.mockResolvedValue({
      activeProvider: null,
      providers: [{ id: 'opencode-vllm-tui', vllmBacked: true, apiKey: '' }],
    });
    providers.updateProvider.mockRejectedValue(new Error('providers.json is locked'));
    stageFreshProject();
    const lines = [];

    const result = await provision(lines);

    // A convenience failing must not undo a successful 30 GB provision.
    expect(result.success).toBe(true);
    expect(emitted(lines)).toMatch(/paste it from \.env/);
    // And the instruction is followable: the key really is in the file.
    expect(files.atomicWrite.mock.calls[0][1]).toMatch(/^VLLM_API_KEY=[0-9a-f]{48}$/m);
  });

  it('skips the build and the prepare when the project is already prepared', async () => {
    const result = await provision();

    expect(result.success).toBe(true);
    // Idempotent: the daemon check and nothing else.
    expect(dockerCalls()).toEqual(['version --format {{.Server.Version}}']);
    // The .env is still topped up — EXTRA_ARGS is exactly the setting a project
    // prepared before this existed is most likely to be missing.
    expect(files.atomicWrite).toHaveBeenCalled();
  });

  it('asks WSL where to put the project on Windows, and records the answer', async () => {
    repin('win32');
    stageFreshProject();
    const lines = [];

    const result = await provision(lines);

    // The whole point: no refusal, no UNC template for a human to fill in.
    expect(result.success).toBe(true);
    expect(project.recordVllmProjectDir).toHaveBeenCalledWith(WSL_DIR);
    expect(emitted(lines)).toContain(WSL_DIR);
    // Recording is what lets the readiness poll and the Start button resolve the
    // same directory this run used.
    expect(emitted(lines)).toMatch(/VLLM_QWEN_PROJECT_DIR/);
  });

  it('never spends a WSL probe when the directory is already settled', async () => {
    repin('win32');
    process.env.VLLM_QWEN_PROJECT_DIR = WSL_DIR;
    stageFreshProject();

    await provision();
    expect(wsl.detectWslProjectDir).not.toHaveBeenCalled();

    // …and the same for a directory an earlier run already recorded.
    delete process.env.VLLM_QWEN_PROJECT_DIR;
    project.vllmProjectDirIsSettled.mockReturnValue(true);
    wsl.detectWslProjectDir.mockClear();
    stageFreshProject();

    await provision();
    expect(wsl.detectWslProjectDir).not.toHaveBeenCalled();
  });

  it('refuses before cloning when WSL cannot offer a home, naming that host\'s fix', async () => {
    repin('win32');
    project.inspectVllmQwenProject.mockResolvedValue(emptyProject);
    wsl.detectWslProjectDir.mockResolvedValue({ dir: null, reason: 'internal-distro', distro: 'docker-desktop', distros: ['Ubuntu'] });

    const result = await provision();

    // Docker Desktop's own distro is wiped on a reset — and the refusal names
    // the distro that ISN'T, rather than a `<distro>` placeholder.
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/docker-desktop/) });
    expect(result.error).toMatch(/wsl --set-default/);
    expect(result.error).toContain('Ubuntu');
    expect(dockerCalls()).toEqual(['version --format {{.Server.Version}}']);
    expect(files.atomicWrite).not.toHaveBeenCalled();
  });

  it('carries on with the detected directory when recording it fails', async () => {
    repin('win32');
    project.recordVllmProjectDir.mockRejectedValue(new Error('.env is read-only'));
    stageFreshProject();
    const lines = [];

    const result = await provision(lines);

    // A ~30 GB run must not be lost to a failed one-line config write — but the
    // consequence (a restart looks on C: again) has to be said out loud.
    expect(result.success).toBe(true);
    expect(emitted(lines)).toMatch(/Could not record VLLM_QWEN_PROJECT_DIR/);
    // And the run itself still uses the detected directory: the process env is
    // the highest-precedence input `resolveVllmProjectDir` reads, so a failed
    // file write cannot send the very next inspection back to C:.
    expect(process.env.VLLM_QWEN_PROJECT_DIR).toBe(WSL_DIR);
  });

  it('refuses before cloning anything when the Docker daemon is not answering', async () => {
    project.inspectVllmQwenProject.mockResolvedValue(emptyProject);
    streaming.runStreamingCommand.mockResolvedValueOnce({ success: false, error: 'exit 1: cannot connect to the Docker daemon' });

    const result = await provision();

    expect(result.success).toBe(false);
    // The daemon's OWN words ride along — "not answering" alone would send the
    // operator looking in the wrong place.
    expect(result.error).toMatch(/Docker daemon is not answering/);
    expect(result.error).toMatch(/cannot connect to the Docker daemon/);
    expect(streaming.runStreamingCommand).toHaveBeenCalledTimes(1);
  });

  it('refuses when git is missing rather than half-cloning', async () => {
    project.inspectVllmQwenProject.mockResolvedValue(emptyProject);
    pathLookup.findCommandOnPath.mockImplementation((cmd) => (cmd === 'docker' ? '/usr/bin/docker' : null));

    const result = await provision();

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/`git` was not found/) });
  });

  it('stops when the clone produced no compose file', async () => {
    project.inspectVllmQwenProject
      .mockResolvedValueOnce(emptyProject)
      .mockResolvedValue({ ...emptyProject, hasProject: true });

    const result = await provision();

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/no docker-compose file/) });
    expect(files.atomicWrite).not.toHaveBeenCalled();
  });

  it('reports the build failure rather than going on to prepare', async () => {
    stageFreshProject();
    streaming.runStreamingCommand.mockImplementation(async (cmd, args) => (
      args.join(' ') === 'compose build' ? { success: false, error: 'exit 1: no CUDA base image' } : { success: true }
    ));

    const result = await provision();

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/docker compose build failed/) });
    expect(dockerCalls()).not.toContain('compose run --rm prepare');
  });

  it('cancels between steps, and never kills a build or a prepare mid-flight', async () => {
    stageFreshProject();

    const result = await provisionVllmQwenProject({ emit: () => {}, isCancelled: () => true });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/cancelled/) });
    // Neither long step may be handed the predicate — killing them is what
    // leaves a half-written image layer behind.
    for (const [, args, , options] of streaming.runStreamingCommand.mock.calls) {
      if (['compose build', 'compose run --rm prepare'].includes(args.join(' '))) {
        expect(options?.isCancelled).toBeUndefined();
      }
    }
  });
});

describe('startVllmQwenProject', () => {
  it('brings up an already-prepared compose project in its own directory', async () => {
    const result = await startVllmQwenProject({ emit: () => {}, isCancelled: () => false });

    expect(result.success).toBe(true);
    expect(streaming.runStreamingCommand).toHaveBeenCalledWith(
      'docker',
      ['compose', '--profile', 'single', 'up', '-d'],
      expect.any(Function),
      expect.objectContaining({ cwd: DIR }),
    );
  });

  // Regression for #4821: the compose file maps "${PORT:-18020}:${PORT:-18020}"
  // and resolves that against docker's OWN caller environment, not the
  // project's .env — an unset `env` here lets PortOS's own PORT (its API
  // server's port, 5555 by default) leak into the child process and collide,
  // remapping the container onto the wrong port. Confirmed on a real RTX 3090
  // run: the resulting bind was literally invalid rather than just wrong.
  it('pins PORT to the vLLM loopback port so PortOS\'s own PORT cannot leak into compose', async () => {
    await startVllmQwenProject({ emit: () => {}, isCancelled: () => false });

    expect(streaming.runStreamingCommand).toHaveBeenCalledWith(
      'docker',
      ['compose', '--profile', 'single', 'up', '-d'],
      expect.any(Function),
      expect.objectContaining({ env: { PORT: '18020' } }),
    );
  });

  it('derives PORT from a non-default endpoint rather than assuming 18020', async () => {
    await startVllmQwenProject({ emit: () => {}, endpoint: 'http://127.0.0.1:19999/v1', isCancelled: () => false });

    expect(streaming.runStreamingCommand).toHaveBeenCalledWith(
      'docker',
      ['compose', '--profile', 'single', 'up', '-d'],
      expect.any(Function),
      expect.objectContaining({ env: { PORT: '19999' } }),
    );
  });

  it('refuses to run compose when the project is not demonstrably prepared', async () => {
    project.vllmStartBlockedReason.mockReturnValue('no Qwen weights are cached yet');

    const result = await startVllmQwenProject({ emit: () => {}, isCancelled: () => false });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/no Qwen weights are cached/) });
    // The whole point: a 20 GB pull is never started on the user's behalf.
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
  });

  it('settles a Windows host\'s project directory before looking for the project', async () => {
    // A checkout prepared inside WSL — by hand, or by another install — sits at
    // a UNC path this PortOS has never been told about. Without this the start
    // looks on C:, finds nothing, and reports "cannot read a models directory".
    repin('win32');

    const result = await startVllmQwenProject({ emit: () => {}, isCancelled: () => false });

    expect(result.success).toBe(true);
    expect(project.recordVllmProjectDir).toHaveBeenCalledWith(WSL_DIR);
  });

  it('refuses without running compose when Windows has no WSL to place it in', async () => {
    repin('win32');
    wsl.detectWslProjectDir.mockResolvedValue({ dir: null, reason: 'no-wsl', error: 'ENOENT' });

    const result = await startVllmQwenProject({ emit: () => {}, isCancelled: () => false });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/wsl --install/) });
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
  });

  it('does not start a container nobody is waiting for', async () => {
    const result = await startVllmQwenProject({ emit: () => {}, isCancelled: () => true });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/Cancelled/) });
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
  });
});
