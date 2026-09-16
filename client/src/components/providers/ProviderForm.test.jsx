import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));

import ProviderForm from './ProviderForm';

// Mounting the form on its own is the point of the extraction: the page-level
// suite has to stand up API + socket wiring to reach a single input, so the
// tab-state invariants below were previously unreachable in isolation.
const renderForm = (props = {}) => render(
  <MemoryRouter initialEntries={['/ai/new']}>
    <ProviderForm onClose={vi.fn()} onSave={vi.fn()} onEditProvider={vi.fn()} {...props} />
  </MemoryRouter>
);

const switchTab = (name) => fireEvent.click(screen.getByRole('tab', { name }));

describe('ProviderForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createProvider.mockResolvedValue({});
    api.updateProvider.mockResolvedValue({});
  });

  it('renders every editor tab', () => {
    renderForm();
    for (const label of ['Connection', 'Models', 'Generation', 'Environment']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  // The Drawer body remounts per tab (key={currentTab}), so any field state left
  // inside a panel would be wiped on a tab switch. All of it is hoisted into the
  // form component above the Drawer — this is the regression guard for that.
  it('keeps entered values when a tab switch unmounts their fields', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Provider' } });

    switchTab('Generation');
    expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Planning Window'), { target: { value: '8192' } });

    switchTab('Connection');
    expect(screen.getByLabelText('Name *')).toHaveValue('Example Provider');

    switchTab('Generation');
    expect(screen.getByLabelText('Planning Window')).toHaveValue(8192);
  });

  // A number input on an unmounted tab is never validated by the browser, so
  // submit re-checks the ranges itself, jumps to the offending tab, and toasts.
  it('blocks submit on an out-of-range numeric field and reveals the tab that owns it', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Provider' } });
    fireEvent.change(screen.getByLabelText('Command *'), { target: { value: 'echo' } });

    switchTab('Generation');
    fireEvent.change(screen.getByLabelText('Planning Window'), { target: { value: '10' } });

    switchTab('Connection');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Planning Window must be between 512 and 2,097,152 tokens');
    });
    expect(api.createProvider).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Planning Window')).toBeInTheDocument();
  });
  it('saves an Ultra mapping after switching away from the Models tab', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Provider' } });
    fireEvent.change(screen.getByLabelText('Command *'), { target: { value: 'example-cli' } });
    switchTab('Models');
    fireEvent.change(screen.getByLabelText('Ultra (frontier)'), { target: { value: 'frontier-model' } });
    switchTab('Connection');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.createProvider).toHaveBeenCalledWith(expect.objectContaining({ ultraModel: 'frontier-model' })));
  });

  it('explains the Claude credential path for a blank-command SGLang harness', () => {
    renderForm({ provider: { id: 'example-local', name: 'Example Local', type: 'tui', command: '', sglangBacked: true } });
    expect(screen.getByText('ANTHROPIC_AUTH_TOKEN')).toBeInTheDocument();
    expect(screen.queryByText(/It rides both the spawned OpenCode provider/)).not.toBeInTheDocument();
  });

  it('folds the credential-bootstrap fields into the nested shape the server expects', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Provider' } });
    fireEvent.change(screen.getByLabelText('Command *'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Setup Command'), { target: { value: 'npm install -g @your-org/token-cli' } });
    fireEvent.change(screen.getByLabelText('Bootstrap Command'), { target: { value: 'token-cli' } });
    fireEvent.change(screen.getByLabelText('Bootstrap Args'), { target: { value: 'run' } });
    fireEvent.change(screen.getByLabelText('Harness ID (optional)'), { target: { value: 'claude-code' } });
    fireEvent.change(screen.getByLabelText('Args Separator (optional)'), { target: { value: '--' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      credentialBootstrap: {
        setupCommand: 'npm install -g @your-org/token-cli',
        command: 'token-cli',
        args: ['run'],
        harnessId: 'claude-code',
        argsSeparator: '--',
      },
    })));
    // No flat scratch fields leak into the payload the server never declared.
    const [payload] = api.createProvider.mock.calls[0];
    expect(payload).not.toHaveProperty('credentialBootstrapCommand');
    expect(payload).not.toHaveProperty('credentialBootstrapArgs');
  });

  it('sends no credentialBootstrap key at all for an api-type provider', async () => {
    renderForm({
      provider: { id: 'example-api', name: 'Example API', type: 'api', endpoint: 'https://api.example.com/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The section is CLI/TUI-only, so an api save must not ship an explicit
    // `null` (which the server would merge onto the record as a literal null).
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    const [, payload] = api.updateProvider.mock.calls[0];
    expect(payload).not.toHaveProperty('credentialBootstrap');
  });

  it('clears a previously-set credential bootstrap when the Bootstrap Command is emptied', async () => {
    renderForm({
      provider: {
        id: 'example-bootstrap', name: 'Example Bootstrap', type: 'cli', command: 'claude',
        credentialBootstrap: { command: 'token-cli', args: ['run'] },
      },
    });
    fireEvent.change(screen.getByLabelText('Bootstrap Command'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // `null`, not omitted — an absent key means "unchanged" on a PATCH, which
    // would leave the stored bootstrap config in place after the user cleared it.
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalledWith('example-bootstrap', expect.objectContaining({
      credentialBootstrap: null,
    })));
  });
});

// #7447: this editor is the surface that literally names the budgeter
// ("Budgeter uses N"), so it must not contradict the card beside it — or the
// server that will enforce the number.
describe('ProviderForm planned context window', () => {
  const daemonProvider = {
    id: 'opencode-vllm',
    name: 'OpenCode vLLM',
    type: 'cli',
    command: 'opencode',
    endpoint: 'http://127.0.0.1:18020/v1',
    models: ['qwen3.8-27b'],
    defaultModel: 'qwen3.8-27b',
    // What a model refresh recorded whenever the user last pressed it.
    modelContextWindows: { 'qwen3.8-27b': 128000 },
    enabled: true,
  };

  const plannedContext = () => {
    switchTab('Generation');
    return screen.getByText(/Budgeter uses/).textContent;
  };

  it('names the window the daemon is serving now, not the stale catalog one', () => {
    renderForm({
      provider: daemonProvider,
      daemonReadiness: { contextWindows: { 'qwen3.8-27b': 32768 } },
    });
    expect(plannedContext()).toBe('Budgeter uses 32K ctx');
  });

  it('falls back to the recorded catalog window when the daemon says nothing', () => {
    renderForm({ provider: daemonProvider, daemonReadiness: { contextWindows: null } });
    expect(plannedContext()).toBe('Budgeter uses 128K ctx');
  });

  it('never writes the observed window back to the record on Save', async () => {
    // The hard constraint from #7441: the observation describes the process
    // running right now, so relaunching the daemon at a different `-c` would
    // make a persisted copy a lie. It reaches the display-only
    // `capabilityProvider` and must not ride a Save from there.
    renderForm({
      provider: daemonProvider,
      daemonReadiness: { contextWindows: { 'qwen3.8-27b': 32768 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    const [, payload] = api.updateProvider.mock.calls[0];
    expect(payload).not.toHaveProperty('modelContextWindows');
  });
});
