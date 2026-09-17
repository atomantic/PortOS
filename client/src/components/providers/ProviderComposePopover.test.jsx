import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProviderComposePopover from './ProviderComposePopover';

afterEach(cleanup);

const CATALOG = {
  harnesses: [
    { id: 'pi', label: 'Pi', modes: ['tui'], enabled: true, detected: true },
    { id: 'claude', label: 'Claude Code', modes: ['cli', 'tui'], enabled: true, detected: true },
  ],
  bootstraps: [{ slug: 'chatgpt', label: 'ChatGPT wrapper' }],
  loading: false,
  compatiblePairs: (harnessId) => (harnessId === 'pi'
    ? [{ slug: 'nvidia-nim-free', label: 'NVIDIA NIM', plan: 'free', enabled: true, credentialVia: 'stored', readiness: 'ready', catalog: { models: ['nvidia/example'] } }]
    : [{ slug: 'anthropic', label: 'Anthropic', plan: 'paid', enabled: true, credentialVia: 'bootstrap', readiness: 'needs-credential', catalog: { models: ['claude-sonnet'] } }]),
  methodsFor: (harnessId) => (harnessId === 'pi' ? ['tui'] : ['cli', 'tui']),
  modelsFor: (slug) => (slug === 'nvidia-nim-free' ? ['nvidia/example'] : slug === 'anthropic' ? ['claude-sonnet'] : []),
  effortLevelsFor: (harnessId) => (harnessId === 'pi' ? ['low', 'medium', 'high', 'xhigh', 'max'] : []),
  savePreset: vi.fn(),
};

const mocked = vi.hoisted(() => ({ useProviderCatalog: vi.fn() }));
vi.mock('../../hooks/useProviderCatalog.js', () => ({ default: mocked.useProviderCatalog }));

beforeEach(() => {
  mocked.useProviderCatalog.mockReturnValue(CATALOG);
  CATALOG.savePreset.mockReset();
});

// Composes down harness -> method -> service, asserting each select only
// appears once its predecessor is chosen (the narrowing the issue asks for).
async function composePiTui() {
  fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'pi' } });
  await waitFor(() => expect(screen.getByLabelText('Method')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'tui' } });
  await waitFor(() => expect(screen.getByLabelText('Service')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'nvidia-nim-free' } });
}

describe('ProviderComposePopover', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<ProviderComposePopover open={false} onClose={vi.fn()} onCompose={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('renders only the Harness select until a harness is chosen, then narrows step by step', async () => {
    render(<ProviderComposePopover open onClose={vi.fn()} onCompose={vi.fn()} />);
    expect(screen.getByLabelText('Harness')).toBeTruthy();
    expect(screen.queryByLabelText('Method')).toBeNull();
    expect(screen.queryByLabelText('Service')).toBeNull();

    await composePiTui();
    expect(screen.getByLabelText('Model')).toBeTruthy();
    expect(screen.getByLabelText('Thinking effort')).toBeTruthy();
  });

  it('emits the composed composite id on "Use once" and closes', async () => {
    const onCompose = vi.fn();
    const onClose = vi.fn();
    render(<ProviderComposePopover open onClose={onClose} onCompose={onCompose} />);
    await composePiTui();

    fireEvent.click(screen.getByRole('button', { name: 'Use once' }));
    expect(onCompose).toHaveBeenCalledWith('pi.tui@nvidia-nim-free', { model: '', effort: '' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('includes the picked model and effort in the emitted composite', async () => {
    const onCompose = vi.fn();
    render(<ProviderComposePopover open onClose={vi.fn()} onCompose={onCompose} />);
    await composePiTui();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'nvidia/example' } });
    fireEvent.change(screen.getByLabelText('Thinking effort'), { target: { value: 'high' } });

    fireEvent.click(screen.getByRole('button', { name: 'Use once' }));
    expect(onCompose).toHaveBeenCalledWith('pi.tui@nvidia-nim-free', { model: 'nvidia/example', effort: 'high' });
  });

  it('clearing the method resets the now-hidden service/model/effort rather than leaving them orphaned', async () => {
    render(<ProviderComposePopover open onClose={vi.fn()} onCompose={vi.fn()} />);
    await composePiTui();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'nvidia/example' } });

    // Method select's blank option clears back to "Choose a method…", which
    // hides Service (gated on harnessId && method) — but Model/Thinking effort
    // are gated on serviceSlug alone, so a stale serviceSlug would leave them
    // rendered with a selection for a service the user can no longer see.
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: '' } });
    expect(screen.queryByLabelText('Service')).toBeNull();
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.queryByLabelText('Thinking effort')).toBeNull();
  });

  it('clears a stale effort when a newly-picked model no longer offers it', async () => {
    const onCompose = vi.fn();
    // Give this harness+service a model whose effort ladder narrows to []
    // when picked, so the previously-selected 'max' has nowhere to live.
    mocked.useProviderCatalog.mockReturnValue({
      ...CATALOG,
      compatiblePairs: () => [{ slug: 'nvidia-nim-free', label: 'NVIDIA NIM', plan: 'free', enabled: true, credentialVia: 'stored', readiness: 'ready', catalog: { models: ['nvidia/example', 'tierless-model'] } }],
      modelsFor: () => ['nvidia/example', 'tierless-model'],
      effortLevelsFor: (_harnessId, model) => (model === 'tierless-model' ? [] : ['low', 'medium', 'high', 'xhigh', 'max']),
    });
    render(<ProviderComposePopover open onClose={vi.fn()} onCompose={onCompose} />);
    await composePiTui();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'nvidia/example' } });
    fireEvent.change(screen.getByLabelText('Thinking effort'), { target: { value: 'max' } });

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'tierless-model' } });
    expect(screen.queryByLabelText('Thinking effort')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Use once' }));
    expect(onCompose).toHaveBeenCalledWith('pi.tui@nvidia-nim-free', { model: 'tierless-model', effort: '' });
  });

  it('disables "Use once" until harness, method and service are all chosen', () => {
    render(<ProviderComposePopover open onClose={vi.fn()} onCompose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Use once' })).toBeDisabled();
  });

  it('requires a credential bootstrap for a service that authenticates via one, and appends its slug', async () => {
    const onCompose = vi.fn();
    render(<ProviderComposePopover open onClose={vi.fn()} onCompose={onCompose} />);
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'claude' } });
    await waitFor(() => expect(screen.getByLabelText('Method')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'cli' } });
    await waitFor(() => expect(screen.getByLabelText('Service')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'anthropic' } });

    const useOnce = screen.getByRole('button', { name: 'Use once' });
    expect(useOnce).toBeDisabled();
    expect(screen.getByLabelText(/Credential bootstrap \(required\)/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Credential bootstrap/), { target: { value: 'chatgpt' } });
    expect(useOnce).not.toBeDisabled();
    fireEvent.click(useOnce);
    expect(onCompose).toHaveBeenCalledWith('claude.cli@anthropic+chatgpt', { model: '', effort: '' });
  });

  it('offers the bootstrap select as OPTIONAL for a service that stores its own credential', async () => {
    render(<ProviderComposePopover open onClose={vi.fn()} onCompose={vi.fn()} />);
    await composePiTui();
    // nvidia-nim-free's credentialVia is 'stored', not 'bootstrap': the select
    // still renders (method is tui and a bootstrap app is configured) but is
    // never marked required, unlike the anthropic/credentialVia:'bootstrap' case.
    expect(screen.getByLabelText('Credential bootstrap')).toBeTruthy();
    expect(screen.queryByText(/required/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Use once' })).not.toBeDisabled();
  });

  it('restricts harnesses and methods to allowedMethods (caller mode policy)', () => {
    render(<ProviderComposePopover open onClose={vi.fn()} onCompose={vi.fn()} allowedMethods={['tui']} />);
    const harnessSelect = screen.getByLabelText('Harness');
    const optionLabels = Array.from(harnessSelect.querySelectorAll('option')).map((o) => o.textContent);
    // Both fixture harnesses support tui, so both remain offered.
    expect(optionLabels).toEqual(expect.arrayContaining(['Pi', 'Claude Code']));
  });

  it('saves the composed combination as a preset and reports it to the caller', async () => {
    CATALOG.savePreset.mockResolvedValue({ id: 'pi-tui-nvidia-nim-free' });
    const onPresetSaved = vi.fn();
    const onClose = vi.fn();
    render(<ProviderComposePopover open onClose={onClose} onCompose={vi.fn()} onPresetSaved={onPresetSaved} />);
    await composePiTui();

    fireEvent.click(screen.getByRole('button', { name: 'Save as preset…' }));
    expect(screen.getByLabelText('Preset name')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'My Pi NIM' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm save' }));
    });

    expect(CATALOG.savePreset).toHaveBeenCalledWith({
      compositeId: 'pi.tui@nvidia-nim-free', name: 'My Pi NIM', model: null, effort: null,
    });
    expect(onPresetSaved).toHaveBeenCalledWith({ id: 'pi-tui-nvidia-nim-free' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resets its fields every time it is reopened', async () => {
    const { rerender } = render(<ProviderComposePopover open onClose={vi.fn()} onCompose={vi.fn()} />);
    await composePiTui();
    expect(screen.getByLabelText('Service')).toHaveValue('nvidia-nim-free');

    rerender(<ProviderComposePopover open={false} onClose={vi.fn()} onCompose={vi.fn()} />);
    rerender(<ProviderComposePopover open onClose={vi.fn()} onCompose={vi.fn()} />);
    expect(screen.getByLabelText('Harness')).toHaveValue('');
    expect(screen.queryByLabelText('Method')).toBeNull();
  });
});
