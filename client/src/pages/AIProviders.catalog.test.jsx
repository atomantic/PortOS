import {
  api,
  localModels,
  toast,
  mountPage,
  renderPage,
  openEditorTab,
  openHeaderMenu,
  clickLoadSamples,
  missingRuntime,
} from './AIProviders.test.fixture.jsx';
import socket from '../services/socket';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PRESET_STATE_ORDER } from './AIProviders';
import { __resetProviderCatalogCache } from '../hooks/useProviderCatalog';
import { CARD_STATE_STYLES } from '../components/providers/ProviderCard';
import { PROVIDER_CARD_STATE } from '../utils/providers';

const socketEvent = event => { for (const [name, handler] of socket.on.mock.calls) if (name === event) handler({}); };

describe('local-daemon readiness on the provider card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'opencode-llama-tui', name: 'OpenCode llama TUI', type: 'tui', command: 'opencode', args: [], enabled: true, endpoint: 'http://127.0.0.1:5568/v1', llamaBacked: true }],
      activeProvider: null,
    });
  });

  it('surfaces the unmet requirements when the local daemon is not running', async () => {
    api.getProviderReadiness.mockResolvedValue({
      readiness: {
        'opencode-llama-tui': {
          kind: 'llama',
          label: 'llama.cpp',
          endpoint: 'http://127.0.0.1:5568/v1',
          manageUrl: '/models/llms',
          docsUrl: 'https://example.com/docs',
          ready: false,
          checks: [
            { id: 'runtime', label: 'llama.cpp installed', ok: false, detail: 'not found', fixHint: 'Install llama.cpp from Models → Runtimes.' },
            { id: 'server', label: 'llama.cpp server responding', ok: false, detail: 'nothing answered', fixHint: 'Install llama.cpp first, then start it.' },
          ],
        },
      },
    });

    await renderPage();

    expect(await screen.findByText(/llama\.cpp setup incomplete/)).toBeInTheDocument();
    expect(screen.getByText(/Install llama\.cpp from Models/)).toBeInTheDocument();
    expect(screen.queryByText(/setup docs/i)).not.toBeInTheDocument();
  });

  it('sends the weights-download action when the checklist offers it', async () => {
    // MTPLX installed, nothing cached: the button is the download, and the
    // action has to reach the setup request — sending the default would run a
    // plain start, which is the failure this whole path exists to avoid.
    api.getProviderReadiness.mockResolvedValue({
      readiness: {
        'opencode-llama-tui': {
          kind: 'mtplx',
          label: 'MTPLX',
          endpoint: 'http://127.0.0.1:8000/v1',
          manageUrl: null,
          ready: false,
          setup: { runtime: 'mtplx', label: 'MTPLX', action: 'pull-start', actionLabel: 'Download the default model & start MTPLX', blockedReason: null },
          checks: [
            { id: 'runtime', label: 'MTPLX installed', ok: true, detail: 'on PATH', fixHint: null },
            { id: 'server', label: 'MTPLX server responding', ok: false, detail: 'MTPLX has no model weights cached, so its server exits before it binds a port.', fixHint: 'Use “Download the default model & start MTPLX” below — PortOS does this for you.' },
          ],
        },
      },
    });

    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Download the default model & start MTPLX/ }));
    const modal = await screen.findByTestId('runtime-install-modal');
    expect(JSON.parse(modal.getAttribute('data-params'))).toEqual({ provider: 'opencode-llama-tui', action: 'pull-start' });
    expect(modal.getAttribute('data-runtime')).toBe('mtplx');
  });

  it('lets the user match this provider to the model llama.cpp is actually serving', async () => {
    api.updateProvider.mockResolvedValue({ id: 'opencode-llama-tui', defaultModel: 'dflash' });
    api.getProviderReadiness.mockResolvedValue({
      readiness: {
        'opencode-llama-tui': {
          kind: 'llama',
          label: 'llama.cpp',
          endpoint: 'http://127.0.0.1:5568/v1',
          manageUrl: '/models/llms',
          ready: false,
          checks: [
            { id: 'runtime', label: 'llama.cpp installed', ok: true, detail: 'on PATH', fixHint: null },
            { id: 'server', label: 'llama.cpp server responding', ok: true, detail: 'answered', fixHint: null },
            {
              id: 'model',
              label: 'Model `qwen3.8-27b-dflash2` available',
              ok: false,
              detail: 'llama.cpp is serving `dflash`.',
              fixHint: 'This provider will send `qwen3.8-27b-dflash2`, but the running server only accepts `dflash`.',
              servedModels: ['dflash'],
            },
          ],
        },
      },
    });
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'opencode-llama-tui',
        name: 'OpenCode llama TUI',
        type: 'tui',
        command: 'opencode',
        args: [],
        enabled: true,
        endpoint: 'http://127.0.0.1:5568/v1',
        llamaBacked: true,
        models: ['dflash', 'qwen3.8-27b-dflash2'],
        defaultModel: 'qwen3.8-27b-dflash2',
      }],
      activeProvider: null,
    });

    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Use dflash as default/ }));
    await waitFor(() => {
      expect(api.updateProvider).toHaveBeenCalledWith('opencode-llama-tui', { defaultModel: 'dflash' });
    });
  });

  it('renders no checklist for a provider the server reports nothing about', async () => {
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });

    await renderPage();

    expect(await screen.findByText('OpenCode llama TUI')).toBeInTheDocument();
    expect(screen.queryByText(/setup incomplete/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ready$/)).not.toBeInTheDocument();
  });
});

describe('an API provider pointed at another machine', () => {
  // `localBackendForProvider` matches by NAME and port, so a provider named
  // "LM Studio <peer>" resolved to the `lmstudio` backend and collected THIS
  // host's install state — a card badged READY carried "LM Studio not
  // installed / Install LM Studio" for a server running on someone else's box.
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    // LM Studio is genuinely absent from THIS machine.
    localModels.value = { ctxById: {}, installed: { ollama: false, lmstudio: false } };
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'lmstudio-peer',
        name: 'LM Studio peer',
        type: 'api',
        enabled: true,
        endpoint: 'http://192.168.1.50:1234/v1',
        models: ['qwen/qwen3.5-35b-a3b'],
        defaultModel: 'qwen/qwen3.5-35b-a3b',
      }],
      activeProvider: null,
    });
  });

  it('offers no local install for it, and does not demand an API key', async () => {
    await renderPage();

    expect(await screen.findByText('LM Studio peer')).toBeInTheDocument();
    expect(screen.queryByText(/LM Studio not installed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Install LM Studio/)).not.toBeInTheDocument();
    // A keyless call to a private-network endpoint is a supported setup, so the
    // card must not contradict the READY badge it is wearing.
    expect(screen.getByText(/none \(private network endpoint\)/)).toBeInTheDocument();
    expect(screen.queryByText(/not set — Edit this provider/)).not.toBeInTheDocument();
  });

  it('still offers the local install for the same backend on THIS machine', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'lmstudio',
        name: 'LM Studio',
        type: 'api',
        enabled: true,
        endpoint: 'http://localhost:1234/v1',
        models: [],
      }],
      activeProvider: null,
    });

    await renderPage();

    expect(await screen.findByText(/LM Studio not installed/)).toBeInTheDocument();
  });
});

describe('fleet LLM setup walkthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
    api.getInstances.mockResolvedValue({
      peers: [{
        id: 'peer-example',
        name: 'Example GPU host',
        host: 'gpu-host.example.ts.net',
        address: '192.0.2.10',
        status: 'online',
        enabled: true,
      }],
    });
    api.createProvider.mockImplementation(async (provider) => ({
      id: 'fleet-gpu-opencode-tui',
      ...provider,
      hasApiKey: true,
    }));
  });

  it('creates an OpenCode provider whose actual baseURL points at the selected peer', async () => {
    await renderPage('/ai/fleet');

    expect(await screen.findByRole('heading', { name: 'Model host setup' })).toBeInTheDocument();


    fireEvent.click(screen.getByRole('tab', { name: 'Connect client' }));
    fireEvent.change(await screen.findByLabelText('Known PortOS peer'), { target: { value: 'peer-example' } });
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'opencode' } });
    fireEvent.change(screen.getByLabelText('vLLM API key'), { target: { value: 'example-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create fleet provider' }));

    await waitFor(() => expect(api.createProvider).toHaveBeenCalledTimes(1));
    const created = api.createProvider.mock.calls[0][0];
    expect(created).toMatchObject({
      type: 'tui',
      command: 'opencode',
      endpoint: 'http://gpu-host.example.ts.net:18022/v1',
      apiKey: 'example-secret',
      defaultModel: 'qwen3.8-27b',
      vllmBacked: true,
      thinking: false,
      enabled: true,
    });
    expect(JSON.parse(created.envVars.OPENCODE_CONFIG_CONTENT).provider.vllm.options.baseURL)
      .toBe('http://gpu-host.example.ts.net:18022/v1');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Model host setup' })).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith('Fleet GPU · OpenCode TUI is connected to the fleet GPU host');
  });

  it('creates a direct API provider without an inert OpenCode config', async () => {
    await renderPage('/ai/fleet?fleetStep=client');

    fireEvent.change(await screen.findByLabelText('Known PortOS peer'), { target: { value: 'peer-example' } });
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'api' } });
    fireEvent.change(screen.getByLabelText('vLLM API key'), { target: { value: 'example-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create fleet provider' }));

    await waitFor(() => expect(api.createProvider).toHaveBeenCalledTimes(1));
    const created = api.createProvider.mock.calls[0][0];
    expect(created).toMatchObject({
      name: 'Fleet GPU · API',
      type: 'api',
      endpoint: 'http://gpu-host.example.ts.net:18022/v1',
      vllmBacked: true,
    });
    expect(created).not.toHaveProperty('command');
    expect(created).not.toHaveProperty('envVars');
  });
});

describe('CoS Agent Runner allowlist warning', () => {
  const cliProvider = (command) => ({
    id: 'p1', name: 'Custom Agent', type: 'cli', enabled: true, command, args: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
  });

  it('badges a provider whose command is off the published allowlist', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('my-custom-agent')],
      activeProvider: 'p1',
      runnerAllowedCommands: ['claude', 'codex'],
    });

    await renderPage();

    expect(await screen.findByText('NO AGENT RUNNER')).toBeInTheDocument();
  });

  it('does not badge a provider whose command IS on the allowlist', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('/usr/local/bin/claude')],
      activeProvider: 'p1',
      runnerAllowedCommands: ['claude', 'codex'],
    });

    await renderPage();

    expect(await screen.findByText('Custom Agent')).toBeInTheDocument();
    expect(screen.queryByText('NO AGENT RUNNER')).not.toBeInTheDocument();
  });

  // A server that predates #4143 omits `runnerAllowedCommands`; an unfetchable
  // list must read as "can't tell", never as "nothing is allowed".
  it('stays silent when the server omits runnerAllowedCommands', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('my-custom-agent')],
      activeProvider: 'p1',
    });

    await renderPage();

    expect(await screen.findByText('Custom Agent')).toBeInTheDocument();
    expect(screen.queryByText('NO AGENT RUNNER')).not.toBeInTheDocument();
  });

  it('warns inline in the editor as the command is typed, without blocking Save', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('claude')],
      activeProvider: 'p1',
      runnerAllowedCommands: ['claude', 'codex'],
    });

    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const commandInput = await screen.findByDisplayValue('claude');
    expect(screen.queryByText(/command allowlist/)).not.toBeInTheDocument();

    fireEvent.change(commandInput, { target: { value: 'my-custom-agent' } });

    expect(await screen.findByText(/command allowlist/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });
});

describe('harness grouping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
  });

  it('groups presets by harness and orders each group by readiness', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'ready', name: 'Ready CLI', type: 'cli', command: 'claude', enabled: true },
        { id: 'off', name: 'Switched Off', type: 'cli', command: 'claude', enabled: false },
        { id: 'keyless', name: 'Keyless Cloud', type: 'api', endpoint: 'https://api.example.com/v1', hasApiKey: false, enabled: true },
      ],
      activeProvider: 'ready',
    });

    await renderPage();

    // Two Claude Code records share one group whatever their readiness; the
    // API record lands under the Direct API harness.
    const claude = await screen.findByRole('button', { name: new RegExp('^Claude Code') });
    expect(claude).toHaveTextContent('2');
    expect(claude).toHaveTextContent('1 of 2 can run');
    expect(screen.getByRole('button', { name: new RegExp('^Direct API') })).toHaveTextContent('0 of 1 can run');
    // Readiness is still on every card as its badge …
    expect(screen.getByText('READY')).toBeInTheDocument();
    expect(screen.getByText('DISABLED')).toBeInTheDocument();
    expect(screen.getByText('NEEDS SETUP')).toBeInTheDocument();
    // The blocker itself stays where its fix is — the card's API-key row.
    expect(screen.getByText(/not set — Edit this provider to paste one/)).toBeInTheDocument();
    // … and decides the order within the group: what can run reads first.
    const ready = screen.getByText('Ready CLI');
    const off = screen.getByText('Switched Off');
    expect(ready.compareDocumentPosition(off) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(PRESET_STATE_ORDER.indexOf(PROVIDER_CARD_STATE.BLOCKED))
      .toBeLessThan(PRESET_STATE_ORDER.indexOf(PROVIDER_CARD_STATE.DISABLED));
  });

  // A switched-off provider is optional — its badge says so and merely notes
  // what enabling it would take, rather than reading as an outstanding task.
  it('badges a switched-off provider with a missing CLI as Disabled, noting the setup', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'opencode-ollama', name: 'OpenCode Ollama', type: 'cli', command: 'opencode', enabled: false }],
      activeProvider: null,
    });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: { opencode: missingRuntime } });

    await renderPage();

    expect(await screen.findByRole('button', { name: new RegExp('^OpenCode') })).toBeInTheDocument();
    expect(screen.getByText('DISABLED')).toBeInTheDocument();
    expect(screen.getByText('SETUP TO ENABLE')).toBeInTheDocument();
    // The missing CLI is still named — that IS the note about enabling it — but
    // in the muted tone, not the amber that would read as a gap in the install.
    const runtimePill = screen.getByText('OpenCode CLI not installed');
    expect(runtimePill).toBeInTheDocument();
    expect(runtimePill.className).not.toMatch(/port-warning/);
    expect(screen.queryByText('NEEDS SETUP')).not.toBeInTheDocument();
  });

  // The provider list is authoritative: no sibling means the wrapper has no key
  // to inherit at spawn time, which is a missing prerequisite, not "unknown".
  it('badges an OrcaRouter wrapper whose sibling was deleted as Needs setup', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'opencode-orcarouter',
        name: 'OpenCode OrcaRouter',
        type: 'cli',
        command: 'opencode',
        enabled: true,
        orcarouterBacked: true,
      }],
      activeProvider: null,
    });

    await renderPage();

    expect(await screen.findByText('NEEDS SETUP')).toBeInTheDocument();
  });

  it('badges an enabled-but-benched provider with its reason', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'claude', name: 'Claude', type: 'cli', command: 'claude', enabled: true }],
      activeProvider: 'claude',
    });
    api.getProviderStatuses.mockResolvedValue({
      providers: { claude: { available: false, reason: 'usage-limit', message: 'Usage limit reached' } },
    });

    await renderPage();

    expect(await screen.findByText('BENCHED · usage-limit')).toBeInTheDocument();
    // A benched provider still counts as runnable — nothing is missing on it.
    expect(screen.getByRole('button', { name: new RegExp('^Claude Code') })).toHaveTextContent('1 of 1 can run');
    expect(screen.queryByText('NEEDS SETUP')).not.toBeInTheDocument();
  });

  it('badges a Codex provider whose ChatGPT quota is exhausted as Benched, still runnable', async () => {
    api.getCodexAccount.mockResolvedValue({
      readiness: {
        status: 'quota-exhausted',
        account: { planType: 'pro' },
        rateLimits: { primary: { usedPercent: 100 } },
      },
    });
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'codex',
        name: 'Codex',
        type: 'cli',
        command: 'codex',
        enabled: true,
      }],
      activeProvider: 'codex',
    });

    await renderPage();

    expect(await screen.findByText('BENCHED · usage-limit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp('^Codex') })).toHaveTextContent('1 of 1 can run');
    expect(screen.queryByText('NEEDS SETUP')).not.toBeInTheDocument();
  });

  it('folds a section away when its header is clicked', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'off', name: 'Switched Off', type: 'cli', command: 'claude', enabled: false }],
      activeProvider: null,
    });

    await renderPage();

    const header = await screen.findByRole('button', { name: /^Claude Code/ });
    expect(screen.getByText('Switched Off')).toBeInTheDocument();

    fireEvent.click(header);
    expect(screen.queryByText('Switched Off')).not.toBeInTheDocument();
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(header);
    expect(screen.getByText('Switched Off')).toBeInTheDocument();
  });
});

describe('hardware-incompatible providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getSampleProviders.mockResolvedValue({ providers: [] });
  });

  // A provider this machine cannot run is not a choice the user can act on, so
  // it must not sit among the enabled cards adding a HARDWARE MISMATCH badge to
  // a section that otherwise lists live providers.
  it('parks an unrunnable provider in a collapsed section instead of its harness group', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'ok', name: 'Runs Here', type: 'cli', command: 'claude', enabled: true },
        {
          id: 'huge',
          name: 'Needs More RAM',
          type: 'api',
          enabled: true,
          endpoint: 'http://localhost:1234',
          hardwareCompatibility: { state: 'unavailable', reasons: ['needs 128GB of RAM'] },
        },
      ],
      activeProvider: 'ok',
    });

    await renderPage();

    const claude = await screen.findByRole('button', { name: new RegExp('^Claude Code') });
    expect(claude).toHaveTextContent('1');
    expect(screen.getByText('Runs Here')).toBeInTheDocument();
    // The unrunnable API record does not surface as a Direct API group.
    expect(screen.queryByRole('button', { name: new RegExp('^Direct API') })).not.toBeInTheDocument();

    // Collapsed by default: neither the card nor its badge is on screen.
    const parked = screen.getByRole('button', { name: /Unavailable on this machine/ });
    expect(parked).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Needs More RAM')).not.toBeInTheDocument();
    expect(screen.queryByText('HARDWARE MISMATCH')).not.toBeInTheDocument();

    // Still one click from being edited or deleted.
    fireEvent.click(parked);
    expect(screen.getByText('Needs More RAM')).toBeInTheDocument();
  });

  it('omits the section entirely when every provider runs here', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'ok', name: 'Runs Here', type: 'cli', command: 'claude', enabled: true }],
      activeProvider: 'ok',
    });

    await renderPage();

    await screen.findByText('Runs Here');
    expect(screen.queryByRole('button', { name: /Unavailable on this machine/ })).not.toBeInTheDocument();
  });

  it('leaves an unrunnable sample out of the sample list', async () => {
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
    api.getSampleProviders.mockResolvedValue({
      providers: [
        { id: 'sample-ok', name: 'Sample Runs Here', type: 'api', enabled: true, endpoint: 'https://api.example.com', models: ['m1'] },
        {
          id: 'sample-huge',
          name: 'Sample Needs More RAM',
          type: 'api',
          enabled: true,
          endpoint: 'https://api.example.com',
          models: ['m2'],
          hardwareCompatibility: { state: 'unavailable', reasons: ['needs 128GB of RAM'] },
        },
      ],
    });

    await renderPage();

    await clickLoadSamples();

    expect(await screen.findByText('Sample Runs Here')).toBeInTheDocument();
    expect(screen.queryByText('Sample Needs More RAM')).not.toBeInTheDocument();
    // One addable sample, so no Add All button and no dead 'Unavailable' action.
    expect(screen.queryByRole('button', { name: /^Add All/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unavailable' })).not.toBeInTheDocument();
  });

  it('says why the sample list is empty when nothing on offer runs here', async () => {
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
    api.getSampleProviders.mockResolvedValue({
      providers: [{
        id: 'sample-huge',
        name: 'Sample Needs More RAM',
        type: 'api',
        enabled: true,
        endpoint: 'https://api.example.com',
        models: ['m2'],
        hardwareCompatibility: { state: 'unavailable', reasons: ['needs 128GB of RAM'] },
      }],
    });

    await renderPage();

    await clickLoadSamples();

    expect(await screen.findByText(/cannot run on this machine/)).toBeInTheDocument();
  });
});

// Both tables are keyed off PROVIDER_CARD_STATE, and a state missing from either
// fails quietly: no PRESET_STATE_ORDER rank sorts those cards to the front of
// every group (indexOf = -1), no CARD_STATE_STYLES row and the card throws on
// `style.border`.
describe('readiness table coverage', () => {
  it('gives every readiness state a card style and exactly one rank', () => {
    for (const state of Object.values(PROVIDER_CARD_STATE)) {
      expect(CARD_STATE_STYLES[state]).toBeDefined();
      expect(PRESET_STATE_ORDER.filter((rank) => rank === state)).toHaveLength(1);
    }
  });
});

describe('Launch in Shell button on TUI provider cards', () => {
  // The card hands the user a one-click way to drive a TUI provider by hand.
  // The link carries only the provider ID — the server pairs the command with
  // the provider's env (its backend/auth) when it spawns the PTY, and those
  // values are secret, so the command line itself must NOT be what's sent.
  // `tuiCommandLine` is the display half: it decides whether the button renders
  // at all (an older server omits it) and shows what will run.
  const baseMocks = () => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
  };

  it('links to the Shell page with the server-built command line', async () => {
    baseMocks();
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'codex',
        name: 'Codex TUI',
        type: 'tui',
        command: 'codex',
        args: [],
        enabled: true,
        tuiCommandLine: 'codex --dangerously-bypass-approvals-and-sandbox --model gpt-5',
      }],
      activeProvider: null,
    });

    await renderPage();

    const link = await screen.findByRole('link', { name: /Launch in Shell/ });
    // By ID, never by command — sending the line would leave the provider's env
    // behind and launch it against the wrong backend.
    expect(link).toHaveAttribute('href', '/shell?provider=codex');
    expect(link.getAttribute('href')).not.toContain('cmd=');
    // The resolved line is still surfaced, so the user can see what will run.
    expect(link).toHaveAttribute('title', expect.stringContaining('--model gpt-5'));
  });

  it('turns into a managed-app picker that launches the shell in the chosen app', async () => {
    baseMocks();
    api.getApps.mockResolvedValue([
      { id: 'app-b', name: 'Beta App', repoPath: '/repos/beta app' },
      { id: 'app-a', name: 'Alpha App', repoPath: '/repos/alpha' },
      { id: 'app-old', name: 'Old App', repoPath: '/repos/old', archived: true },
      { id: 'app-norepo', name: 'No Repo App' },
    ]);
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'codex', name: 'Codex TUI', type: 'tui', command: 'codex', args: [], enabled: true, tuiCommandLine: 'codex' }],
      activeProvider: null,
    });

    await renderPage();

    const picker = await screen.findByRole('combobox', { name: 'Launch in Shell in app' });
    // Only live apps with a checkout to cd into, alphabetical after the prompt.
    expect(within(picker).getAllByRole('option').map(o => o.textContent)).toEqual(['Launch in Shell…', 'Alpha App', 'Beta App']);
    fireEvent.change(picker, { target: { value: 'app-b' } });
    expect(await screen.findByTestId('shell-location')).toHaveTextContent('/shell?provider=codex&cwd=%2Frepos%2Fbeta+app');
  });

  it('keeps the home-folder link when every app with a repo path is archived', async () => {
    baseMocks();
    api.getApps.mockResolvedValue([{ id: 'app-old', name: 'Old App', repoPath: '/repos/old', archived: true }]);
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'codex', name: 'Codex TUI', type: 'tui', command: 'codex', args: [], enabled: true, tuiCommandLine: 'codex' }],
      activeProvider: null,
    });

    await renderPage();

    expect(await screen.findByRole('link', { name: /Launch in Shell/ })).toHaveAttribute('href', '/shell?provider=codex');
  });

  it('renders no button for a CLI provider, or when the server sent no command line', async () => {
    baseMocks();
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', args: [], enabled: true },
        { id: 'legacy-tui', name: 'Legacy TUI', type: 'tui', command: 'claude', args: [], enabled: true },
      ],
      activeProvider: null,
    });

    await renderPage();

    expect(await screen.findByText('Legacy TUI')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Launch in Shell/ })).not.toBeInTheDocument();
  });
});

describe('provider card layout', () => {
  // The card's details used to be the FIRST flex item of the same row that
  // holds the action buttons. The button group never shrinks below its
  // max-content width (seven buttons ≈ 660px), so on a real desktop card the
  // details were squeezed into a ~275px column of hard-wrapped text beside an
  // empty half-card. Keeping the details OUT of that row is what fixes it, so
  // that is what this pins — a class assertion would just restate the JSX.
  it('renders the details below the action row, not as a flex sibling of it', async () => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'opencode-llama',
        name: 'OpenCode llama TUI',
        type: 'tui',
        command: 'opencode',
        args: [],
        enabled: true,
        defaultModel: 'dflash',
        tuiCommandLine: 'opencode',
      }],
      activeProvider: null,
    });

    await renderPage();

    const deleteButton = await screen.findByRole('button', { name: 'Delete' });
    // The row that lays identity out against the actions — one level above the
    // button group the Delete button sits in.
    const headerRow = deleteButton.closest('.flex-wrap').parentElement;
    expect(headerRow.className).toContain('flex-row');
    expect(headerRow.textContent).toContain('OpenCode llama TUI');
    expect(headerRow.textContent).not.toContain('Command:');
    expect(headerRow.textContent).not.toContain('Default:');
  });
});

describe('vLLM-backed TUI provider', () => {
  const vllmTui = (overrides = {}) => ({
    id: 'opencode-vllm-tui',
    name: 'OpenCode vLLM TUI (Qwen3.8-27B)',
    type: 'tui',
    command: 'opencode',
    args: [],
    enabled: true,
    endpoint: 'http://127.0.0.1:18020/v1',
    models: ['qwen3.8-27b'],
    defaultModel: 'qwen3.8-27b',
    vllmBacked: true,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
  });

  it('badges the card so the GPU-exclusive backend is visible at a glance', async () => {
    api.getProviders.mockResolvedValue({ providers: [vllmTui()], activeProvider: null });
    await renderPage();
    expect(await screen.findByText('vLLM / DFLASH2')).toBeInTheDocument();
  });

  it('offers an API Key field on a TUI provider — the container is key-gated', async () => {
    api.getProviders.mockResolvedValue({ providers: [vllmTui()], activeProvider: null });
    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const key = await screen.findByLabelText('API Key');
    fireEvent.change(key, { target: { value: 'vllm-key-example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateProvider).toHaveBeenCalledWith(
      'opencode-vllm-tui',
      expect.objectContaining({ apiKey: 'vllm-key-example' }),
    ));
  });

  it('keeps the field off an unauthenticated local TUI backend', async () => {
    api.getProviders.mockResolvedValue({
      providers: [vllmTui({ id: 'opencode-mtplx-tui', name: 'OpenCode MTPLX TUI', vllmBacked: undefined, mtplxBacked: true })],
      activeProvider: null,
    });
    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByDisplayValue('opencode');
    expect(screen.queryByLabelText('API Key')).toBeNull();
  });
});

// A refresh used to end in `loadData()`, which flips the page's `loading` flag
// back on — the whole list is replaced by the skeleton and the browser lands at
// the top, so the card the user clicked (often several screens down) scrolls out
// from under them. The card has to update in place instead.
describe('AIProviders model refresh', () => {
  const executionModes = [{ id: 'opencode-mtplx', type: 'cli' }, { id: 'opencode-mtplx-tui', type: 'tui' }];

  const mtplxProviders = () => ({
    activeProvider: null,
    providers: [
      {
        id: 'opencode-mtplx', name: 'OpenCode MTPLX', type: 'cli', command: 'opencode', enabled: true,
        models: ['mtplx-served'], canRefreshModels: true, executionModes,
      },
      {
        id: 'opencode-mtplx-tui', name: 'OpenCode MTPLX TUI', type: 'tui', command: 'opencode', enabled: true,
        models: ['mtplx-served'], canRefreshModels: true, executionModes,
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getCodexAccount.mockImplementation(() => new Promise(() => {}));
    api.getProviders.mockResolvedValue(mtplxProviders());
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
  });

  it('applies the refreshed catalog to the clicked card without reloading the page', async () => {
    api.refreshProviderModels.mockResolvedValue({
      id: 'opencode-mtplx', name: 'OpenCode MTPLX', type: 'cli', command: 'opencode', enabled: true,
      models: ['mtplx-served', 'wang-yang/Ornith-1.0-35B-MTPLX'], canRefreshModels: true,
    });

    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Models' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Models refreshed for OpenCode MTPLX'));
    expect(await screen.findByText(/Models: mtplx-served, wang-yang\/Ornith-1\.0-35B-MTPLX/)).toBeInTheDocument();
    // One load, from the initial mount — the refresh must not re-fetch the whole
    // page, which is what unmounted the list and reset the scroll position.
    expect(api.getProviders).toHaveBeenCalledTimes(1);
    // The unified card keeps its grouping: replacing the entry wholesale with
    // the bare record the refresh route returns would drop `executionModes` and
    // split one card into two.
    expect(screen.getAllByRole('button', { name: 'Refresh Models' })).toHaveLength(1);
  });

  it.each([
    { mode: 'CLI', providerId: 'claude-code' },
    { mode: 'TUI', providerId: 'claude-code-tui' },
  ])('uses the refreshed full catalog when editing a paired $mode preset', async ({ mode, providerId }) => {
    const catalogBeforeRefresh = ['example-claude-old', 'example-claude-retired'];
    const catalogAfterRefresh = ['example-claude-current', 'example-claude-preview'];
    const claudeExecutionModes = [{ id: 'claude-code', type: 'cli' }, { id: 'claude-code-tui', type: 'tui' }];
    const claudeProviders = {
      activeProvider: null,
      providers: ['cli', 'tui'].map((type) => ({
        id: `claude-code${type === 'tui' ? '-tui' : ''}`,
        name: `Claude Code${type === 'tui' ? ' TUI' : ''}`,
        type,
        command: 'claude',
        enabled: true,
        models: [catalogBeforeRefresh[0]],
        modelCatalog: catalogBeforeRefresh,
        modelAccess: { mode: 'allow', patterns: ['example-claude-*'] },
        canRefreshModels: true,
        executionModes: claudeExecutionModes,
      })),
    };
    api.getProviders.mockResolvedValue(claudeProviders);
    api.refreshProviderModels.mockResolvedValue({
      ...claudeProviders.providers[0],
      models: [catalogAfterRefresh[0]],
      modelCatalog: catalogAfterRefresh,
      canRefreshModels: true,
    });
    api.updateProvider.mockResolvedValue({});

    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Models' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Models refreshed for Claude Code'));

    fireEvent.click(await screen.findByRole('button', { name: `Edit ${mode}` }));
    await openEditorTab('Models');
    const catalogField = screen.getByRole('textbox', { name: /Available Models/i });
    expect(catalogField).toHaveValue(catalogAfterRefresh.join(', '));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    expect(api.updateProvider).toHaveBeenCalledWith(providerId, expect.objectContaining({ models: catalogAfterRefresh }));
  });

  it('keeps the stored catalog when the refresh is unsupported', async () => {
    api.refreshProviderModels.mockResolvedValue(null);

    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Models' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByText(/Models: mtplx-served$/)).toBeInTheDocument();
  });

  it('renders a typed MTPLX stopped refusal inline on the card, with a link to the MTPLX card', async () => {
    api.refreshProviderModels.mockRejectedValue(Object.assign(new Error(
      'MTPLX is stopped and has no saved launch line — open Models → Runtimes to start it and save its launch line, then refresh again.',
    ), { code: 'MTPLX_STOPPED' }));

    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Models' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('MTPLX is stopped'));
    const link = screen.getByRole('link', { name: 'Open the MTPLX card' });
    expect(link).toHaveAttribute('href', '/models/llms-runtimes/mtplx');
    // The inline card is the one place the fix is named — no toast around it.
    expect(toast.error).not.toHaveBeenCalled();

    // A later refresh clears the refusal once the server answers again.
    api.refreshProviderModels.mockResolvedValue({
      id: 'opencode-mtplx', name: 'OpenCode MTPLX', type: 'cli', command: 'opencode', enabled: true,
      models: ['mtplx-served'], canRefreshModels: true,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Models' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('uses the management URL and label supplied by a non-MTPLX refresh refusal', async () => {
    api.getProviders.mockResolvedValue({
      activeProvider: null,
      providers: [{
        id: 'splash', name: 'Splash', type: 'api', endpoint: 'http://127.0.0.1:19001/v1',
        enabled: true, splashBacked: true, canRefreshModels: true, models: [],
      }],
    });
    api.refreshProviderModels.mockRejectedValue(Object.assign(new Error('Splash needs a saved launch configuration.'), {
      code: 'RUNTIME_SETUP_REQUIRED',
      context: { refreshNotice: {
        manageUrl: '/models/llms-runtimes/splash#setup',
        manageLabel: 'Open Splash setup',
      } },
    }));

    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Models' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Splash needs a saved launch configuration.');
    expect(screen.getByRole('link', { name: 'Open Splash setup' }))
      .toHaveAttribute('href', '/models/llms-runtimes/splash#setup');
    expect(toast.error).not.toHaveBeenCalled();
  });

  // The root cause under the refresh button, which the other four reload paths
  // on this page share: `loadData` flipped `loading` on unconditionally, so ANY
  // reload after a click swapped the whole list for the page skeleton and
  // returned the user to the top. The skeleton belongs to the first load only.
  it('applies a disable in place: no re-read and no skeleton', async () => {
    api.updateProvider.mockResolvedValue({ id: 'opencode-mtplx', enabled: false });
    api.getProviders.mockResolvedValue(mtplxProviders());

    mountPage();
    // The first load DOES show the skeleton — this keeps the assertion below
    // from passing vacuously.
    expect(screen.getByLabelText('Loading providers')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));

    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading providers')).toBeNull();
    expect(screen.getByRole('heading', { name: 'OpenCode MTPLX' })).toBeInTheDocument();
    expect(api.getProviders).toHaveBeenCalledTimes(1);
  });
});

// The compatibility matrix (#7567) is rendered from the composition catalog
// every picker reads, so a cell can only disagree with what compose offers
// by the catalog being stale — never by a second predicate in the browser.
describe('compatibility matrix', () => {
  const catalog = {
    harnesses: [
      { id: 'claude', label: 'Claude Code', modes: ['cli', 'tui'], enabled: true, detected: true },
      { id: 'pi', label: 'Pi', modes: ['cli', 'tui'], enabled: false, detected: false },
      { id: 'direct', label: 'Direct API', modes: ['api'], enabled: true, detected: true },
    ],
    services: [
      { slug: 'ollama', label: 'Ollama', plan: 'local', enabled: true, readiness: 'ready', catalog: { models: ['qwen3:8b'] } },
      { slug: 'nvidia-nim', label: 'NVIDIA NIM', plan: 'free', enabled: true, readiness: 'needs-credential', catalog: { models: [] } },
    ],
    bootstraps: [],
    compatibility: { claude: ['ollama'], pi: ['ollama', 'nvidia-nim'], direct: ['ollama', 'nvidia-nim'] },
    effortLevels: { claude: ['low', 'medium', 'high'], pi: [], direct: [] },
    effortLevelsByModel: {},
    presets: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetProviderCatalogCache();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
    api.getProviderCatalog.mockResolvedValue(catalog);
  });

  it('renders the server verdict per cell: offered, blocked with its reason, or unreachable', async () => {
    await renderPage();
    const header = await screen.findByRole('button', { name: /Compatibility matrix/ });
    await waitFor(() => expect(header).toHaveTextContent('2 combinations offered'));
    fireEvent.click(header);
    // Claude × Ollama: compatible, both on, ready → a click target.
    expect(screen.getByRole('button', { name: 'New preset: Claude Code on Ollama' })).toBeInTheDocument();
    // Claude × NVIDIA: not in the compatibility map → unreachable, not blocked.
    expect(screen.getByRole('img', { name: 'Claude Code cannot reach NVIDIA NIM' })).toBeInTheDocument();
    // Pi is switched off → blocked with that reason, even on a ready service.
    expect(screen.getByRole('img', { name: 'Pi on Ollama: Pi is switched off' })).toBeInTheDocument();
    // Direct × NVIDIA: compatible and on, but the service still needs a key.
    expect(screen.getByRole('img', { name: 'Direct API on NVIDIA NIM: NVIDIA NIM needs a credential' })).toBeInTheDocument();
  });

  it('opens the compose flow on the clicked pair with only "Save as preset" as its exit, then lands on the new preset', async () => {
    api.createProviderPreset.mockResolvedValue({ id: 'claude-cli-ollama', name: 'Claude Code · Ollama' });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Compatibility matrix/ }));
    fireEvent.click(screen.getByRole('button', { name: 'New preset: Claude Code on Ollama' }));

    const dialog = await screen.findByRole('dialog', { name: 'Compose a new preset' });
    // The popover is a lazy chunk that mounts already open, so its catalog loads
    // after the dialog shell appears; the seeded pair is selectable only once it has.
    await waitFor(() => expect(within(dialog).getByLabelText('Harness')).toHaveValue('claude'));
    expect(within(dialog).getByLabelText('Method')).toHaveValue('cli');
    expect(within(dialog).getByLabelText('Service')).toHaveValue('ollama');
    expect(within(dialog).queryByRole('button', { name: 'Use once' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save as preset…' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm save' }));
    await waitFor(() => expect(api.createProviderPreset).toHaveBeenCalledWith(expect.objectContaining({ compositeId: 'claude.cli@ollama' })));
    // The page reloads its presets and opens the editor on the one just saved.
    await waitFor(() => expect(api.getProviders).toHaveBeenCalledTimes(2));
    expect(toast.success).toHaveBeenCalledWith('Claude Code · Ollama saved as a preset');
  });

  it('opens compose from Add Preset, saves a derived preset, and opens the editor on the service-owned fields', async () => {
    const derived = {
      id: 'claude-cli-ollama',
      name: 'Claude Code · Ollama',
      type: 'cli',
      command: 'claude',
      enabled: true,
      presetKind: 'derived',
      presetDerivable: false,
      harnessId: 'claude',
      method: 'cli',
      serviceId: 'ollama',
    };
    const existing = { id: 'existing', name: 'Existing', type: 'cli', command: 'claude', enabled: true };
    let providerLoads = 0;
    api.getProviders.mockImplementation(() => {
      providerLoads += 1;
      const providers = providerLoads === 1 ? [existing] : [existing, derived];
      return Promise.resolve({ providers, activeProvider: null });
    });
    api.createProviderPreset.mockResolvedValue(derived);
    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Add Preset' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compose a new preset' });
    expect(within(dialog).getByLabelText('Harness')).toHaveValue('');
    await waitFor(() => expect(within(dialog).getByLabelText('Harness')).not.toBeDisabled());
    fireEvent.change(within(dialog).getByLabelText('Harness'), { target: { value: 'claude' } });
    fireEvent.change(await within(dialog).findByLabelText('Method'), { target: { value: 'cli' } });
    fireEvent.change(within(dialog).getByLabelText('Service'), { target: { value: 'ollama' } });
    expect(api.refreshProviderModels).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save as preset…' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm save' }));
    await waitFor(() => expect(api.createProviderPreset).toHaveBeenCalledWith(expect.objectContaining({ compositeId: 'claude.cli@ollama' })));
    expect(await screen.findByText(/Derived from service/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'service settings for ollama' })).toHaveAttribute('href', '/ai/services/ollama');
    expect(screen.queryByLabelText('Command *')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name *')).toHaveValue('Claude Code · Ollama');
    expect(screen.getByLabelText('Arguments (space-separated)')).toBeInTheDocument();
  });

  it('opens compose from a ready service card with that service selected after a compatible harness and method', async () => {
    api.getProviderServices.mockResolvedValue({
      services: [{
        id: 'uuid-ollama', revision: 1, kind: 'ollama', label: 'Ollama', slug: 'ollama', definitionId: 'ollama',
        plan: 'local', enabled: true, credentialVia: 'stored', hasCredentials: false, credentialSource: 'none', bindingCount: 0,
        readiness: 'ready', transports: { openai: { baseUrl: 'http://127.0.0.1:11434/v1' } },
        catalog: { state: 'known', models: ['qwen3:8b'] },
        definition: { id: 'ollama', label: 'Ollama', family: 'local', plans: ['local'], catalogStrategy: 'daemon', harnessOnly: null, keyUrl: null, envVars: [] },
      }],
    });
    await renderPage('/ai/services');
    fireEvent.click(await screen.findByRole('button', { name: 'Create preset from Ollama' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compose a new preset' });
    expect(within(dialog).queryByLabelText('Service')).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText('Harness')).not.toBeDisabled());
    fireEvent.change(within(dialog).getByLabelText('Harness'), { target: { value: 'claude' } });
    fireEvent.change(await within(dialog).findByLabelText('Method'), { target: { value: 'cli' } });
    expect(within(dialog).getByLabelText('Service')).toHaveValue('ollama');
    expect(api.refreshProviderModels).not.toHaveBeenCalled();
  });
});

describe('page views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetProviderCatalogCache();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
  });

  it('routes the three views through the Models strip and swaps the header action per view', async () => {
    await renderPage('/ai/services');
    expect(await screen.findByRole('button', { name: 'Add Service' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run Prompt' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('AI Services');
    expect(screen.queryByRole('tablist', { name: 'AI provider views' })).not.toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Models sections' });
    expect(within(tabs).getAllByRole('tab', { selected: true }).map((tab) => tab.textContent)).toEqual(['AI Services']);
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Providers' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Providers' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Run Prompt' })).toBeInTheDocument();
    // The header action plus the empty state's own — both create a preset.
    expect(screen.getAllByRole('button', { name: 'Add Preset' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Add Service' })).not.toBeInTheDocument();
  });

  it('keeps the blank legacy form behind Add standalone preset', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'codex', name: 'Codex', type: 'cli', command: 'codex', enabled: true }],
      activeProvider: null,
    });
    await renderPage();
    await openHeaderMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add standalone preset' }));
    expect(await screen.findByRole('heading', { name: 'Add Provider' })).toBeInTheDocument();
    expect(screen.getByLabelText('Type *')).toBeInTheDocument();
    expect(screen.getByLabelText('Command *')).toBeInTheDocument();
  });
});

describe('default provider helper and card highlight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetProviderCatalogCache();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
  });

  it('renders the helper at the top showing default provider, model, effort and highlights the card', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        {
          id: 'claude-tui',
          name: 'Claude Code TUI',
          type: 'tui',
          command: 'claude',
          defaultModel: 'claude-opus-4-7',
          effort: 'high',
          enabled: true,
        },
        {
          id: 'opencode-tui',
          name: 'OpenCode TUI',
          type: 'tui',
          command: 'opencode',
          defaultModel: 'ox-alpha',
          effort: 'medium',
          enabled: true,
        },
      ],
      activeProvider: 'claude-tui',
    });

    await renderPage();

    const helper = await screen.findByTestId('default-provider-helper');
    expect(helper).toBeInTheDocument();
    expect(within(helper).getByTestId('default-helper-provider-name')).toHaveTextContent('Claude Code TUI');
    expect(within(helper).getByTestId('default-helper-provider-name')).toHaveTextContent('(Claude Code)');
    expect(within(helper).getByTestId('default-helper-model')).toHaveTextContent('claude-opus-4-7');
    expect(within(helper).getByTestId('default-helper-effort')).toHaveTextContent('high');

    // Default card has color-coded background and ring
    const defaultCard = document.getElementById('provider-card-claude-tui');
    expect(defaultCard).toHaveClass('bg-port-accent/10');
    expect(defaultCard).not.toHaveClass('bg-port-card');
    expect(defaultCard).toHaveClass('ring-1');

    // Non-default card has standard background
    const otherCard = document.getElementById('provider-card-opencode-tui');
    expect(otherCard).toHaveClass('bg-port-card');
    expect(otherCard).not.toHaveClass('bg-port-accent/10');

    // Clicking Jump to card calls scrollIntoView
    const scrollSpy = vi.fn();
    defaultCard.scrollIntoView = scrollSpy;
    fireEvent.click(within(helper).getByRole('button', { name: /Jump to card/ }));
    expect(scrollSpy).toHaveBeenCalled();
  });
});

it('shares readiness subscriptions and reconciles events, reconnect and tab show without polling', async () => {
  vi.clearAllMocks();
  api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
  api.getApps.mockResolvedValue([]);
  api.getProviderStatuses.mockResolvedValue({ providers: {} });
  api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
  api.getProviderReadiness.mockResolvedValue({ readiness: {} });

  await renderPage();
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  try {
    const count = api.getProviderReadiness.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getProviderReadiness).toHaveBeenCalledTimes(count);
    api.getProviderReadiness.mockRejectedValueOnce(new Error('unavailable'));
    await act(async () => { socketEvent('provider-readiness:changed'); });
    const warning = screen.getByText(/Provider readiness status unavailable/).closest('[role="status"]');
    expect(warning).toHaveClass('text-port-warning');
    expect(warning).not.toHaveAttribute('variant');
    expect(warning.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    expect(api.getProviderReadiness).toHaveBeenCalledTimes(count + 1);
    await act(async () => { socketEvent('connect'); });
    expect(api.getProviderReadiness).toHaveBeenCalledTimes(count + 2);
    expect(screen.queryByText(/Provider readiness status unavailable/)).not.toBeInTheDocument();
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    visibility.mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(api.getProviderReadiness).toHaveBeenCalledTimes(count + 3);
    expect(socket.emit).toHaveBeenCalledWith('provider-readiness:subscribe');
  } finally {
    visibility.mockRestore();
    vi.useRealTimers();
  }
});

describe('provider list ordering', () => {
  const providers = ['a', 'b'].map(id => ({
    id, name: `Provider ${id}`, type: 'api', enabled: true,
    endpoint: 'https://example.test', models: ['example-model'],
  }));
  const snapshot = (activeProvider = 'a', disabled = []) => ({
    activeProvider,
    providers: providers.map(provider => ({ ...provider, enabled: !disabled.includes(provider.id) })),
  });
  const card = id => within(document.getElementById(`provider-card-${id}`));
  // Disable and Delete patch the list in place, so a reload in flight is started
  // by adding a sample preset (which re-reads the list).
  const samples = ['s1', 's2'].map(id => ({ id, name: `Sample ${id}`, type: 'api', enabled: true, endpoint: 'https://example.test', models: ['m'] }));
  const reloadViaSample = async () => {
    const addButton = (await screen.findAllByRole('button', { name: 'Add' }))[0];
    await act(async () => { fireEvent.click(addButton); });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetProviderCatalogCache();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.updateProvider.mockResolvedValue({});
    api.setActiveProvider.mockResolvedValue({});
    api.getProviders.mockResolvedValue(snapshot());
    api.createProvider.mockResolvedValue({});
    api.getSampleProviders.mockResolvedValue({ providers: samples });
  });

  it.each(['success', 'failure'])('keeps Set Default after an older Disable read ends in %s and reconciles', async outcome => {
    let resolveOld, rejectOld, resolveFresh;
    api.getProviders.mockResolvedValueOnce(snapshot())
      .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveFresh = resolve; }));
    await renderPage();
    await clickLoadSamples();
    await reloadViaSample();
    await waitFor(() => expect(api.getProviders).toHaveBeenCalledTimes(2));
    fireEvent.click(card('b').getByRole('button', { name: 'Set Default' }));
    await waitFor(() => expect(card('b').getByText('DEFAULT')).toBeInTheDocument());
    await act(async () => {
      if (outcome === 'success') resolveOld(snapshot('a', ['a']));
      else rejectOld(new Error('offline'));
    });
    expect(card('b').getByText('DEFAULT')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
    expect(api.getProviders).toHaveBeenCalledTimes(3);
    await act(async () => resolveFresh(snapshot('b', ['a'])));
    expect(card('b').getByText('DEFAULT')).toBeInTheDocument();
    expect(card('a').getByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });

  it('keeps the newer read when two Disable reloads finish out of order', async () => {
    let resolveOld, resolveNew;
    api.getProviders.mockResolvedValueOnce(snapshot())
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    await renderPage();
    await clickLoadSamples();
    await reloadViaSample();
    await waitFor(() => expect(api.getProviders).toHaveBeenCalledTimes(2));
    await reloadViaSample();
    await waitFor(() => expect(api.getProviders).toHaveBeenCalledTimes(3));
    await act(async () => resolveNew(snapshot('a', ['a', 'b'])));
    await act(async () => resolveOld(snapshot('a', ['a'])));
    expect(card('b').getByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });

  it('shows a failed reconciliation read and recovers with Retry', async () => {
    api.getProviders.mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new Error('offline'));
    await renderPage();
    await clickLoadSamples();
    await reloadViaSample();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Provider b' })).toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
  });
});
