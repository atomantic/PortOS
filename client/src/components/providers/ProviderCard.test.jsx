import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProviderCard from './ProviderCard';
import { PROVIDER_CARD_STATE } from '../../utils/providers';

const wrapper = (overrides = {}) => ({
  id: 'opencode-openrouter-tui',
  name: 'OpenCode OpenRouter TUI',
  type: 'tui',
  command: 'opencode',
  endpoint: 'https://openrouter.ai/api/v1',
  models: ['openrouter/auto', 'stealth/ox-alpha'],
  defaultModel: 'stealth/ox-alpha',
  enabled: true,
  ...overrides,
});

const renderCard = (provider, daemonReadiness = null, props = {}) => render(
  <MemoryRouter>
    <ProviderCard
      provider={provider}
      daemonReadiness={daemonReadiness}
      // `providerCardState` returns `missing` on every path, so the fixture
      // carries it too — the card reads it without a defensive guard.
      cardState={{ state: PROVIDER_CARD_STATE.READY, missing: [] }}
      runtime={null}
      status={null}
      isDefault={false}
      providersById={{}}
      runnerAllowedCommands={[]}
      testResult={null}
      {...props}
    />
  </MemoryRouter>
);

describe('ProviderCard context window', () => {
  it('labels the blanket 128K as an assumption, not a measured window', () => {
    // Printing it bare made a 1M-context model look like PortOS had capped it,
    // with nothing on screen to say the number was a guess or how to fix it.
    renderCard(wrapper({ canRefreshModels: true }));
    expect(screen.getByText('128K ctx')).toBeTruthy();
    expect(screen.getByText(/assumed — Refresh Models to read the real one/)).toBeTruthy();
  });

  it('points a provider with no model-list capability at the editor instead', () => {
    // `assumed` is reached by every process provider with an unrecognized
    // model, but the Refresh Models button is gated on canRefreshModels —
    // advising a button that is not on the card is worse than saying nothing.
    renderCard(wrapper());
    expect(screen.getByText(/assumed — set a context window when editing this provider/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh Models' })).toBeNull();
  });

  it('prints the catalog window plainly once model refresh has recorded it', () => {
    renderCard(wrapper({ modelContextWindows: { 'stealth/ox-alpha': 1_000_000 } }));
    expect(screen.getByText('1M ctx')).toBeTruthy();
    expect(screen.queryByText(/assumed/)).toBeNull();
  });

  it('marks a hand-entered window as an override', () => {
    renderCard(wrapper({ contextWindow: 250_000 }));
    expect(screen.getByText('250K ctx')).toBeTruthy();
    expect(screen.getByText('override')).toBeTruthy();
    expect(screen.queryByText(/assumed/)).toBeNull();
  });

  // #7447: the meter must show the number the DISPATCH GATE would enforce. A
  // card reading 128K beside an endpoint serving 32K promised a budget no run
  // could ever spend — the chunker built the oversized prompt and the gate
  // refused it.
  it('shows the window the daemon is serving right now, over a stale catalog entry', () => {
    renderCard(
      wrapper({ modelContextWindows: { 'stealth/ox-alpha': 128_000 } }),
      { contextWindows: { 'stealth/ox-alpha': 32_768 } },
    );
    expect(screen.getByText('32K ctx')).toBeTruthy();
    expect(screen.queryByText('128K ctx')).toBeNull();
    expect(screen.queryByText(/assumed/)).toBeNull();
  });

  it('still lets a hand-entered window beat the live observation', () => {
    renderCard(
      wrapper({ contextWindow: 250_000 }),
      { contextWindows: { 'stealth/ox-alpha': 32_768 } },
    );
    expect(screen.getByText('250K ctx')).toBeTruthy();
    expect(screen.getByText('override')).toBeTruthy();
  });

  it('renders exactly as before when the daemon reported no window', () => {
    // Down, silent, or not daemon-backed at all — unknown stays unknown.
    renderCard(wrapper({ canRefreshModels: true }), { contextWindows: null });
    expect(screen.getByText('128K ctx')).toBeTruthy();
    expect(screen.getByText(/assumed — Refresh Models to read the real one/)).toBeTruthy();
  });
});

describe('ProviderCard fleet identity', () => {
  it('decorates a private remote runtime and assigns lifecycle to that host', () => {
    renderCard(wrapper({
      name: 'Fleet GPU',
      endpoint: 'http://gpu-host.example.ts.net:18020/v1',
      vllmBacked: true,
    }));

    expect(screen.getByText('FLEET HOST')).toBeInTheDocument();
    expect(screen.getByText(/Fleet vLLM runtime/)).toBeInTheDocument();
    expect(screen.getByText(/Runs on/)).toHaveTextContent('gpu-host.example.ts.net');
    expect(screen.queryByText(/Local vLLM container/)).not.toBeInTheDocument();
  });

  it('does not decorate a public hosted API as a fleet host', () => {
    renderCard(wrapper({ endpoint: 'https://api.example.com/v1' }));
    expect(screen.queryByText('FLEET HOST')).not.toBeInTheDocument();
  });
});

describe('ProviderCard ChatGPT subscription', () => {
  it('shows a safe sign-in action without rendering account identity or credentials', () => {
    render(
      <MemoryRouter>
        <ProviderCard
          provider={{ id: 'codex', name: 'Codex', type: 'cli', command: 'codex', models: [], enabled: true }}
          cardState={{ state: PROVIDER_CARD_STATE.BLOCKED, missing: [{ code: 'codexAccount', label: 'No ChatGPT account is signed in' }] }}
          runtime={null}
          status={null}
          isDefault={false}
          providersById={{}}
          runnerAllowedCommands={[]}
          testResult={null}
          codexAccount={{
            status: 'signed-out',
            account: { accountId: 'private-account', email: 'private@example.test' },
            rateLimits: null,
          }}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use device code' })).toBeInTheDocument();
    expect(screen.queryByText('private-account')).toBeNull();
    expect(screen.queryByText('private@example.test')).toBeNull();
  });

  it('does not render a non-HTTPS sign-in link', () => {
    render(
      <MemoryRouter>
        <ProviderCard
          provider={{ id: 'codex', name: 'Codex', type: 'cli', command: 'codex', models: [], enabled: true }}
          cardState={{ state: PROVIDER_CARD_STATE.BLOCKED, missing: [{ code: 'codexAccount', label: 'No ChatGPT account is signed in' }] }}
          runtime={null}
          status={null}
          isDefault={false}
          providersById={{}}
          runnerAllowedCommands={[]}
          testResult={null}
          codexAccount={{ status: 'login-pending', login: { authUrl: 'javascript:alert(1)' } }}
        />
      </MemoryRouter>
    );

    expect(screen.queryByRole('link', { name: 'Open ChatGPT sign-in' })).toBeNull();
  });

  it('badges quota-exhausted card as benched usage-limit with fallback routing explanation', () => {
    render(
      <MemoryRouter>
        <ProviderCard
          provider={{ id: 'codex', name: 'Codex', type: 'cli', command: 'codex', models: [], enabled: true }}
          cardState={{ state: PROVIDER_CARD_STATE.BENCHED, missing: [] }}
          runtime={null}
          status={null}
          isDefault={false}
          providersById={{}}
          runnerAllowedCommands={[]}
          testResult={null}
          codexAccount={{
            status: 'quota-exhausted',
            account: { planType: 'pro' },
            rateLimits: { primary: { usedPercent: 100 } },
          }}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('BENCHED · usage-limit')).toBeInTheDocument();
    expect(screen.getByTitle('ChatGPT usage limit reached — calls route to the fallback.')).toBeInTheDocument();
  });
});

describe('ProviderCard model refresh', () => {
  it('renders the Refresh Models button for a Codex provider with model-list capability', () => {
    renderCard({
      id: 'codex',
      name: 'Codex CLI',
      type: 'cli',
      command: 'codex',
      models: ['gpt-6-astra'],
      canRefreshModels: true,
      enabled: true,
    });
    expect(screen.getByRole('button', { name: 'Refresh Models' })).toBeInTheDocument();
  });
});


/**
 * The NVIDIA NIM key link. What this uniquely catches: the card says the
 * provider needs an API key but never says WHERE to get one.
 */
describe('ProviderCard gateway key link', () => {
  const nim = {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    type: 'api',
    endpoint: 'https://integrate.api.nvidia.com/v1',
    models: ['google/gemma-4-31b-it'],
    enabled: true,
  };

  it('links a keyless NVIDIA NIM card to build.nvidia.com', () => {
    renderCard(nim);
    const link = screen.getByRole('link', { name: 'Get a NVIDIA NIM key' });
    expect(link).toHaveAttribute('href', 'https://build.nvidia.com');
  });

  it('shows no key link for an API provider with no vendor key page', () => {
    renderCard({ ...nim, id: 'some-api', name: 'Some API' });
    expect(screen.queryByRole('link', { name: /Get a .* key/ })).toBeNull();
  });

  it('shows no key link once the NVIDIA NIM key is set', () => {
    renderCard({ ...nim, hasApiKey: true });
    expect(screen.queryByRole('link', { name: /Get a .* key/ })).toBeNull();
  });
});
/**
 * The routing-override badge (#6304). What this uniquely catches: the card
 * silently presenting ChatGPT account quota for work that account never served,
 * and the inverse leak — the machine-local base URL reaching a card that has no
 * advisory to render.
 */
describe('ProviderCard codex routing override', () => {
  const codex = (overrides = {}) => ({
    id: 'codex',
    name: 'Codex CLI',
    type: 'cli',
    command: 'codex',
    models: ['gpt-5.6-terra'],
    enabled: true,
    ...overrides,
  });
  const advisory = {
    code: 'codexRoutingOverridden',
    label: 'Codex model routing is overridden by your own ~/.codex/config.toml',
    keys: ['openai_base_url'],
    baseUrl: 'http://127.0.0.1:9999/v1',
  };

  it('names the overridden route and caveats the subscription quota', () => {
    renderCard(codex({ prerequisiteAdvisories: [advisory] }));
    expect(screen.getByText(/Model routing is overridden by your Codex config/)).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:9999/v1')).toBeTruthy();
    expect(screen.getByText(/may not be counted here/)).toBeTruthy();
  });

  it('renders nothing — and no base URL — when the server published no advisory', () => {
    renderCard(codex({ prerequisiteAdvisories: [] }));
    expect(screen.queryByText(/Model routing is overridden/)).toBeNull();
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
    expect(screen.queryByText(/may not be counted here/)).toBeNull();
  });
});

describe('ProviderCard delete confirmation', () => {
  const renderDeletable = (provider, props = {}) => {
    const onDelete = vi.fn();
    renderCard(provider, null, { onDelete, ...props });
    return onDelete;
  };

  it('asks before deleting instead of firing on the first click', () => {
    // Delete sits in the same button row as Test and Edit and the record is not
    // recoverable — a misclick there used to destroy the provider outright.
    const onDelete = renderDeletable(wrapper());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete OpenCode OpenRouter TUI\?/)).toBeTruthy();
  });

  it('deletes once the confirm button is pressed', () => {
    const onDelete = renderDeletable(wrapper());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete provider' }));
    expect(onDelete).toHaveBeenCalledWith('opencode-openrouter-tui');
  });

  it('cancels back to the card without deleting', () => {
    const onDelete = renderDeletable(wrapper());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText(/Delete OpenCode OpenRouter TUI\?/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('warns that a unified card takes both modes with it', () => {
    // The server deletes the whole mode group, so a question naming only the
    // mode whose button was clicked would understate what is about to happen.
    const cli = wrapper({ id: 'opencode-cli', name: 'OpenCode CLI', type: 'cli' });
    const tui = wrapper({ id: 'opencode-tui', name: 'OpenCode TUI' });
    renderDeletable(
      { ...cli, executionModes: [{ id: 'opencode-cli' }, { id: 'opencode-tui' }] },
      { providersById: { 'opencode-cli': cli, 'opencode-tui': tui } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/Both its CLI and TUI modes are removed/)).toBeTruthy();
  });
});

describe('ProviderCard "Add interactive mode"', () => {
  const cliRecord = (overrides = {}) => wrapper({
    id: 'opencode-cli', name: 'OpenCode CLI', type: 'cli', canAddTuiMode: true, ...overrides,
  });

  it('offers the action on an unpaired CLI record and hands the whole provider to the page', () => {
    // The record already carries the command, endpoint, credentials and env the
    // sibling needs — the click is the whole interaction, not a pre-filled form.
    const onAddTuiMode = vi.fn();
    const provider = cliRecord();
    renderCard(provider, null, { onAddTuiMode });
    fireEvent.click(screen.getByRole('button', { name: /Add interactive mode/ }));
    expect(onAddTuiMode).toHaveBeenCalledWith(provider);
  });

  it('offers nothing on an already-unified card, a TUI record, or an api record', () => {
    const expectNoAction = () => expect(screen.queryByRole('button', { name: /Add interactive mode/ })).toBeNull();

    // Unified: the pair exists, so there is nothing to add. Flagged `true` on
    // purpose — the server would never say so, and this pins that a card
    // rendering a stale list still refuses rather than offering a second TUI.
    const cli = cliRecord();
    const tui = wrapper({ id: 'opencode-tui', name: 'OpenCode TUI' });
    renderCard(
      { ...cli, executionModes: [{ id: 'opencode-cli' }, { id: 'opencode-tui' }] },
      null,
      { providersById: { 'opencode-cli': cli, 'opencode-tui': tui } },
    );
    expectNoAction();

    // A TUI record: the CLI id is the stem, so minting it here is a rename.
    renderCard(wrapper());
    expectNoAction();

    renderCard(wrapper({ id: 'openai', name: 'OpenAI', type: 'api' }));
    expectNoAction();
  });

  it('shows the in-flight state rather than letting a second click mint twice', () => {
    const onAddTuiMode = vi.fn();
    renderCard(cliRecord(), null, { onAddTuiMode, addingTuiMode: true });
    const button = screen.getByRole('button', { name: /Adding/ });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onAddTuiMode).not.toHaveBeenCalled();
  });
});
