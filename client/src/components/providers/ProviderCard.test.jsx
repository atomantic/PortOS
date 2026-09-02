import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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

const renderCard = (provider) => render(
  <MemoryRouter>
    <ProviderCard
      provider={provider}
      // `providerCardState` returns `missing` on every path, so the fixture
      // carries it too — the card reads it without a defensive guard.
      cardState={{ state: PROVIDER_CARD_STATE.READY, missing: [] }}
      runtime={null}
      status={null}
      isDefault={false}
      providersById={{}}
      runnerAllowedCommands={[]}
      testResult={null}
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
});
