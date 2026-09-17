import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The preset-first selector (#7566): harness-grouped presets, the "Custom
// combination…" compose flow wired to `ProviderComposePopover`, composites
// resolved from the shared catalog, and caller-mode restrictions on compose.
const api = vi.hoisted(() => ({ getProviderCatalog: vi.fn(), createProviderPreset: vi.fn(), getToolUseModels: vi.fn() }));
vi.mock('../services/api', async (importOriginal) => ({ ...(await importOriginal()), ...api }));
vi.mock('../services/apiLocalLlm', () => ({ getToolUseModels: (...a) => api.getToolUseModels(...a) }));

import ProviderModelSelector from './ProviderModelSelector';
import { __resetProviderCatalogCache } from '../hooks/useProviderCatalog.js';
import { COMPOSE_OPTION_VALUE, providerModeSelectionPolicy } from '../utils/providerSelection.js';

const PRESETS = [
  { id: 'lmstudio', name: 'LM Studio', type: 'api', enabled: true, models: ['qwen'] },
  { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', enabled: true },
  { id: 'codex-cli', name: 'Codex CLI', type: 'cli', command: 'codex', enabled: true, models: ['gpt-5'] },
  { id: 'agy-cli', name: 'Antigravity', type: 'cli', command: 'agy', enabled: true, models: ['gemini-3.6-flash-low', 'gemini-3.6-flash-high', 'claude-sonnet-4-6'] },
  { id: 'mystery', name: 'Mystery', type: 'cli', command: 'mystery-bin', enabled: true },
];

const CATALOG = {
  harnesses: [
    { id: 'pi', label: 'Pi', modes: ['tui', 'cli'], enabled: true, detected: true },
    { id: 'codex', label: 'Codex', modes: ['cli'], enabled: true, detected: true },
    { id: 'antigravity', label: 'Antigravity', modes: ['cli'], enabled: true, detected: true },
  ],
  services: [
    { slug: 'nvidia-nim-free', label: 'NVIDIA NIM', plan: 'free', enabled: true, credentialVia: 'stored', readiness: 'ready', catalog: { models: ['nvidia/example', 'nvidia/other'] } },
    { slug: 'retired-svc', label: 'Retired', plan: 'paid', enabled: false, credentialVia: 'stored', readiness: 'disabled', catalog: { models: ['old-model'] } },
    { slug: 'openai', label: 'OpenAI', plan: 'paid', enabled: true, credentialVia: 'stored', readiness: 'ready', catalog: { models: ['gpt-5'] } },
    { slug: 'google', label: 'Google', plan: 'paid', enabled: true, credentialVia: 'stored', readiness: 'ready', catalog: { models: ['claude-sonnet-4-6', 'gemini-3.6-flash-low', 'gemini-3.6-flash-high'] } },
  ],
  bootstraps: [],
  compatibility: { pi: ['nvidia-nim-free', 'retired-svc'], codex: ['openai'], antigravity: ['google'] },
  effortLevels: { pi: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high'], antigravity: ['low', 'medium', 'high'] },
  effortLevelsByModel: { pi: {}, codex: {}, antigravity: {} },
  presets: PRESETS,
};

const optgroupLabels = (select) => [...select.querySelectorAll('optgroup')].map((g) => g.label);
const optionsIn = (select, groupLabel) =>
  [...select.querySelector(`optgroup[label="${groupLabel}"]`).querySelectorAll('option')].map((o) => o.textContent);

function renderSelector(props = {}) {
  const handlers = { onProviderChange: vi.fn(), onModelChange: vi.fn(), onEffortChange: vi.fn() };
  const element = (next) => (
    <ProviderModelSelector providers={PRESETS} selectedProviderId="claude-code" effort="" {...handlers} {...props} {...next} />
  );
  const { rerender } = render(element());
  return { ...handlers, rerender: (next) => rerender(element(next)) };
}

const providerSelect = () => screen.getByRole('combobox', { name: 'Provider' });
// The popover is a dialog with its own Model/Thinking-effort selects, so its
// controls are scoped to it — the selector's own siblings share those names.
const composeVia = async ({ harness, method, service, model, effort }) => {
  fireEvent.change(providerSelect(), { target: { value: COMPOSE_OPTION_VALUE } });
  const dialog = within(await screen.findByRole('dialog'));
  const harnessSelect = dialog.getByRole('combobox', { name: 'Harness' });
  await waitFor(() => expect(harnessSelect.disabled).toBe(false));
  fireEvent.change(harnessSelect, { target: { value: harness } });
  fireEvent.change(dialog.getByRole('combobox', { name: 'Method' }), { target: { value: method } });
  fireEvent.change(dialog.getByRole('combobox', { name: 'Service' }), { target: { value: service } });
  if (model) fireEvent.change(dialog.getByRole('combobox', { name: 'Model' }), { target: { value: model } });
  if (effort) fireEvent.change(dialog.getByRole('combobox', { name: 'Thinking effort' }), { target: { value: effort } });
};

beforeEach(() => {
  __resetProviderCatalogCache();
  api.getProviderCatalog.mockReset().mockResolvedValue(CATALOG);
  api.createProviderPreset.mockReset();
  api.getToolUseModels.mockReset().mockResolvedValue({ providers: [] });
});
afterEach(cleanup);

describe('ProviderModelSelector — preset-first', () => {
  it('groups presets by harness in registry order, then a Custom group ending in the compose entry', () => {
    renderSelector({ selectedProviderId: 'mystery' });
    const select = providerSelect();
    expect(optgroupLabels(select)).toEqual(['Claude Code', 'Codex', 'Antigravity', 'Direct API', 'Other', 'Custom']);
    expect(optionsIn(select, 'Direct API')).toEqual(['LM Studio']);
    expect(optionsIn(select, 'Other')).toEqual(['Mystery']);
    expect(optionsIn(select, 'Custom')).toEqual(['Custom combination…']);
    // No catalog fetch for a plain preset list — the many preset-only pickers must stay free.
    expect(api.getProviderCatalog).not.toHaveBeenCalled();
    // One dropdown by default: no model/effort select until a preset with models is chosen.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('opens the compose popover from the compose entry without emitting the sentinel, and emits the composed selection on "Use once"', async () => {
    const handlers = renderSelector();
    await composeVia({ harness: 'pi', method: 'tui', service: 'nvidia-nim-free', model: 'nvidia/other', effort: 'high' });
    expect(handlers.onProviderChange).not.toHaveBeenCalled();
    expect(providerSelect().value).toBe('claude-code');
    fireEvent.click(screen.getByRole('button', { name: 'Use once' }));
    expect(handlers.onProviderChange).toHaveBeenCalledWith('pi.tui@nvidia-nim-free');
    expect(handlers.onModelChange).toHaveBeenCalledWith('nvidia/other');
    expect(handlers.onEffortChange).toHaveBeenCalledWith('high');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Harness' })).toBeNull());
  });

  it('renders a composed value the caller\'s list does not carry as its own Custom option, with the service catalog and harness ladder', async () => {
    renderSelector({ selectedProviderId: 'pi.tui@nvidia-nim-free', selectedModel: 'nvidia/other', effort: 'high' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Pi · TUI · NVIDIA NIM (free)' })).toBeTruthy());
    const select = providerSelect();
    expect(select.value).toBe('pi.tui@nvidia-nim-free');
    expect(optionsIn(select, 'Custom')).toEqual(['Pi · TUI · NVIDIA NIM (free)', 'Custom combination…']);
    const modelSelect = screen.getByRole('combobox', { name: 'Model' });
    expect([...modelSelect.options].map((o) => o.value)).toEqual(['nvidia/example', 'nvidia/other']);
    expect([...screen.getByRole('combobox', { name: 'Thinking effort' }).options].map((o) => o.value))
      .toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('keeps a saved composite whose service is now switched off visible with its reason, and never auto-replaces it', async () => {
    const handlers = renderSelector({ selectedProviderId: 'pi.tui@retired-svc', selectedModel: 'old-model' });
    const option = await screen.findByRole('option', { name: 'Pi · TUI · Retired (Retired is switched off)' });
    expect(option.disabled).toBe(true);
    expect(providerSelect().value).toBe('pi.tui@retired-svc');
    expect(handlers.onProviderChange).not.toHaveBeenCalled();
    expect(handlers.onModelChange).not.toHaveBeenCalled();
  });

  it('keeps an unresolvable saved composite on screen rather than blanking the field', async () => {
    api.getProviderCatalog.mockResolvedValue({ ...CATALOG, harnesses: [], compatibility: {} });
    renderSelector({ selectedProviderId: 'ghost.cli@nowhere' });
    const option = await screen.findByRole('option', { name: 'ghost.cli@nowhere (not available on this install)' });
    expect(option.disabled).toBe(true);
    expect(providerSelect().value).toBe('ghost.cli@nowhere');
  });

  it('round-trips "Save as preset": the new preset is selected with its defaults and listed under its harness', async () => {
    api.createProviderPreset.mockResolvedValue({
      id: 'pi-nim', name: 'Pi on NIM', type: 'tui', harnessId: 'pi', enabled: true,
      defaultModel: 'nvidia/other', effort: 'high', models: ['nvidia/example', 'nvidia/other'],
    });
    const handlers = renderSelector();
    await composeVia({ harness: 'pi', method: 'tui', service: 'nvidia-nim-free', model: 'nvidia/other', effort: 'high' });
    fireEvent.click(screen.getByRole('button', { name: 'Save as preset…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Preset name' }), { target: { value: 'Pi on NIM' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm save' }));
    await waitFor(() => expect(handlers.onProviderChange).toHaveBeenCalledWith('pi-nim'));
    expect(api.createProviderPreset).toHaveBeenCalledWith({ compositeId: 'pi.tui@nvidia-nim-free', name: 'Pi on NIM', model: 'nvidia/other', effort: 'high' });
    expect(handlers.onModelChange).toHaveBeenCalledWith('nvidia/other');
    expect(handlers.onEffortChange).toHaveBeenCalledWith('high');
  });

  it('shows the saved preset under its harness group once the caller reflects the selection', async () => {
    api.createProviderPreset.mockResolvedValue({ id: 'pi-nim', name: 'Pi on NIM', type: 'tui', harnessId: 'pi', enabled: true, models: [] });
    const { onProviderChange, rerender } = renderSelector();
    await composeVia({ harness: 'pi', method: 'tui', service: 'nvidia-nim-free' });
    fireEvent.click(screen.getByRole('button', { name: 'Save as preset…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm save' }));
    await waitFor(() => expect(onProviderChange).toHaveBeenCalledWith('pi-nim'));
    rerender({ selectedProviderId: 'pi-nim' });
    expect(optgroupLabels(providerSelect())).toContain('Pi');
    expect(optionsIn(providerSelect(), 'Pi')).toEqual(['Pi on NIM']);
    expect(providerSelect().value).toBe('pi-nim');
  });

  it('switches the effort ladder with the harness: codex is per-model, antigravity disappears for a tier-less model', async () => {
    const { rerender } = renderSelector({ selectedProviderId: 'codex.cli@openai', selectedModel: 'gpt-5' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Thinking effort' })).toBeTruthy());
    const codexLadder = [...screen.getByRole('combobox', { name: 'Thinking effort' }).options].map((o) => o.value);
    expect(codexLadder).toContain('high');
    rerender({ selectedProviderId: 'antigravity.cli@google', selectedModel: 'claude-sonnet-4-6' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Antigravity · CLI · Google' })).toBeTruthy());
    expect(screen.queryByRole('combobox', { name: 'Thinking effort' })).toBeNull();
    rerender({ selectedProviderId: 'antigravity.cli@google', selectedModel: 'gemini-3.6-flash' });
    expect([...screen.getByRole('combobox', { name: 'Thinking effort' }).options].map((o) => o.value)).toEqual(['', 'low', 'high']);
  });

  it('restricts compose to the caller-mode policy, and drops the entry when the policy permits nothing', async () => {
    renderSelector({ selectionPolicy: providerModeSelectionPolicy('cli-harness'), selectedProviderId: 'codex-cli' });
    fireEvent.change(providerSelect(), { target: { value: COMPOSE_OPTION_VALUE } });
    const dialog = within(await screen.findByRole('dialog'));
    const harnessSelect = dialog.getByRole('combobox', { name: 'Harness' });
    await waitFor(() => expect(harnessSelect.disabled).toBe(false));
    fireEvent.change(harnessSelect, { target: { value: 'pi' } });
    expect([...dialog.getByRole('combobox', { name: 'Method' }).options].map((o) => o.value)).toEqual(['', 'cli']);
    cleanup();
    renderSelector({ selectionPolicy: providerModeSelectionPolicy('no-such-policy') });
    expect(screen.queryByRole('option', { name: 'Custom combination…' })).toBeNull();
  });

  it('omits the Custom group entirely on a preset-only surface (compose={false})', () => {
    renderSelector({ compose: false });
    expect(optgroupLabels(providerSelect())).not.toContain('Custom');
    expect(screen.queryByRole('option', { name: 'Custom combination…' })).toBeNull();
  });
});
