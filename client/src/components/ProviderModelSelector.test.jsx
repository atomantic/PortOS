import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// The tool-use annotation unions the server's authoritative capability list into
// the client id regex, so the picker fetches it whenever `highlightToolUse` is on.
const getToolUseModels = vi.fn();
vi.mock('../services/apiLocalLlm', () => ({ getToolUseModels: (...a) => getToolUseModels(...a) }));

import ProviderModelSelector from './ProviderModelSelector';
import { __resetToolUseModelIdsCache } from '../hooks/useToolUseModelIds.js';
import SHIPPED_PROVIDERS from '../../../data.reference/providers.json';

const PROVIDERS = [
  { id: 'p1', name: 'Provider One' },
  { id: 'p2', name: 'Provider Two' },
];

function renderSelector(props = {}) {
  return render(
    <ProviderModelSelector
      providers={PROVIDERS}
      selectedProviderId="p1"
      selectedModel="m1"
      availableModels={['m1', 'm2']}
      onProviderChange={() => {}}
      onModelChange={() => {}}
      {...props}
    />
  );
}

describe('ProviderModelSelector', () => {
  it('renders only the provider options by default (no empty sentinel)', () => {
    renderSelector();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Provider One', 'Provider Two', 'm1', 'm2']);
  });

  it('renders every current Codex fallback choice, including Codex Spark', () => {
    const codexModels = SHIPPED_PROVIDERS.providers.codex.models;
    expect(codexModels).toContain('gpt-5.3-codex-spark');
    renderSelector({
      providers: [{ id: 'codex', name: 'Codex CLI', type: 'cli', models: codexModels }],
      selectedProviderId: 'codex',
      selectedModel: 'gpt-5.3-codex-spark',
      availableModels: codexModels,
    });
    const modelSelect = screen.getAllByRole('combobox')[1];
    expect([...modelSelect.querySelectorAll('option')].map((option) => option.value)).toEqual(codexModels);
    expect(modelSelect.value).toBe('gpt-5.3-codex-spark');
  });

  it('prepends empty options with value "" when emptyProviderOption/emptyModelOption are set', () => {
    renderSelector({ emptyProviderOption: 'Use default', emptyModelOption: 'Default model' });
    const providerSelect = screen.getAllByRole('combobox')[0];
    const firstProviderOption = providerSelect.querySelector('option');
    expect(firstProviderOption.value).toBe('');
    expect(firstProviderOption.textContent).toBe('Use default');

    const modelSelect = screen.getAllByRole('combobox')[1];
    const firstModelOption = modelSelect.querySelector('option');
    expect(firstModelOption.value).toBe('');
    expect(firstModelOption.textContent).toBe('Default model');
  });

  it('hides the model select when availableModels is empty (default)', () => {
    renderSelector({ availableModels: [] });
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('renders the model select even when empty if alwaysShowModel is set', () => {
    renderSelector({ availableModels: [], alwaysShowModel: true, emptyModelOption: 'Default model' });
    const combos = screen.getAllByRole('combobox');
    expect(combos).toHaveLength(2);
    expect(combos[1].querySelector('option').textContent).toBe('Default model');
  });

  it('normalizes object-shaped model entries to value/label', () => {
    renderSelector({
      availableModels: [{ id: 'mid', name: 'Pretty Name' }, { id: 'bare' }],
      selectedModel: 'mid',
    });
    const modelSelect = screen.getAllByRole('combobox')[1];
    const opts = [...modelSelect.querySelectorAll('option')];
    expect(opts.map((o) => o.value)).toEqual(['mid', 'bare']);
    // `{ id }` with no name falls back to the id as the label.
    expect(opts.map((o) => o.textContent)).toEqual(['Pretty Name', 'bare']);
  });

  it('skips nullish model entries instead of crashing (sparse/empty provider list)', () => {
    // useProviderModels can pass `[undefined]` for a provider with no models;
    // modelOption must tolerate it and the map must skip it.
    expect(() =>
      renderSelector({ availableModels: [undefined, 'm2', null], alwaysShowModel: true })
    ).not.toThrow();
    const modelSelect = screen.getAllByRole('combobox')[1];
    expect([...modelSelect.querySelectorAll('option')].map((o) => o.value)).toEqual(['m2']);
  });

  it('fires onProviderChange/onModelChange with the selected value', () => {
    const onProviderChange = vi.fn();
    const onModelChange = vi.fn();
    renderSelector({ onProviderChange, onModelChange });
    const [providerSelect, modelSelect] = screen.getAllByRole('combobox');
    fireEvent.change(providerSelect, { target: { value: 'p2' } });
    expect(onProviderChange).toHaveBeenCalledWith('p2');
    fireEvent.change(modelSelect, { target: { value: 'm2' } });
    expect(onModelChange).toHaveBeenCalledWith('m2');
  });

  it('filters out disabled providers from the dropdown', () => {
    renderSelector({
      providers: [
        { id: 'p1', name: 'Provider One' },
        { id: 'p2', name: 'Provider Two', enabled: false },
        { id: 'p3', name: 'Provider Three', enabled: true },
      ],
    });
    const providerSelect = screen.getAllByRole('combobox')[0];
    const labels = [...providerSelect.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual(['Provider One', 'Provider Three']);
  });

  it('keeps a disabled provider visible when it is the current selection', () => {
    renderSelector({
      selectedProviderId: 'p2',
      providers: [
        { id: 'p1', name: 'Provider One' },
        { id: 'p2', name: 'Provider Two', enabled: false },
      ],
    });
    const providerSelect = screen.getAllByRole('combobox')[0];
    const labels = [...providerSelect.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual(['Provider One', 'Provider Two']);
  });

  it('hides incompatible providers and models while preserving selected pins', () => {
    renderSelector({
      providers: [
        { id: 'p1', name: 'Provider One', modelHardwareCompatibility: { 'too-large': { state: 'unavailable' } } },
        { id: 'p2', name: 'Provider Two', hardwareCompatibility: { state: 'unavailable' } },
        { id: 'p3', name: 'Provider Three' },
      ],
      selectedModel: 'too-large',
      availableModels: ['too-large', 'small'],
    });
    const [providerSelect, modelSelect] = screen.getAllByRole('combobox');
    expect([...providerSelect.querySelectorAll('option')].map((option) => option.value)).toEqual(['p1', 'p3']);
    expect([...modelSelect.querySelectorAll('option')].map((option) => option.value)).toEqual(['too-large', 'small']);
    expect(modelSelect.querySelector('option[value="too-large"]').disabled).toBe(true);
  });

  it('stacks the selects vertically when layout="stacked"', () => {
    const { container } = renderSelector({ layout: 'stacked' });
    expect(container.firstChild.className).toContain('flex-col');
  });

  describe('highlightToolUse (agent pickers)', () => {
    const OLLAMA = [{ id: 'ollama', name: 'Ollama' }];
    const modelLabels = () =>
      [...screen.getAllByRole('combobox')[1].querySelectorAll('option')].map((o) => o.textContent);

    beforeEach(() => {
      vi.clearAllMocks();
      __resetToolUseModelIdsCache();
      // Default: the capability scan finds nothing extra, so every assertion
      // below is about the id regex unless the case says otherwise.
      getToolUseModels.mockResolvedValue({ models: [] });
    });

    it('marks local model options with a tool-use indicator', async () => {
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'qwen3.6:35b',
        availableModels: ['qwen3.6:35b', 'gemma3:4b'],
        highlightToolUse: true,
      });
      await waitFor(() =>
        expect(modelLabels()).toEqual(['qwen3.6:35b · 🔧 tool use', 'gemma3:4b · ⚠ no known tool use']));
    });

    it('warns when the selected LOCAL model cannot call tools', async () => {
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'gemma3:4b',
        availableModels: ['qwen3.6:35b', 'gemma3:4b'],
        highlightToolUse: true,
      });
      expect(await screen.findByText(/recognized tool-calling model/i)).toBeInTheDocument();
    });

    it('warns on the provider default when the model selection is blank', async () => {
      // "Default model" (blank) isn't a no-op — the resolver runs the provider's
      // defaultModel, which here is a non-tool local model.
      renderSelector({
        providers: [{ id: 'ollama', name: 'Ollama', defaultModel: 'gemma3:4b' }],
        selectedProviderId: 'ollama',
        selectedModel: '',
        availableModels: ['qwen3.6:35b', 'gemma3:4b'],
        alwaysShowModel: true,
        emptyModelOption: 'Default model',
        highlightToolUse: true,
      });
      expect(await screen.findByText(/recognized tool-calling model/i)).toBeInTheDocument();
    });

    it('does not warn when the selected local model is tool-capable', async () => {
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'qwen3.6:35b',
        availableModels: ['qwen3.6:35b', 'gemma3:4b'],
        highlightToolUse: true,
      });
      await waitFor(() => expect(getToolUseModels).toHaveBeenCalled());
      expect(screen.queryByText(/recognized tool-calling model/i)).not.toBeInTheDocument();
    });

    it('is a no-op for cloud providers (ids do not encode family)', async () => {
      renderSelector({
        providers: [{ id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1' }],
        selectedProviderId: 'openai',
        selectedModel: 'gpt-4o',
        availableModels: ['gpt-4o', 'o1'],
        highlightToolUse: true,
      });
      await waitFor(() => expect(getToolUseModels).toHaveBeenCalled());
      expect(modelLabels()).toEqual(['gpt-4o', 'o1']);
      expect(screen.queryByText(/recognized tool-calling model/i)).not.toBeInTheDocument();
    });

    it('leaves options unannotated when highlightToolUse is off (default)', () => {
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'gemma3:4b',
        availableModels: ['qwen3.6:35b', 'gemma3:4b'],
      });
      expect(modelLabels()).toEqual(['qwen3.6:35b', 'gemma3:4b']);
      expect(screen.queryByText(/recognized tool-calling model/i)).not.toBeInTheDocument();
      // An unannotated picker must not pay for the capability scan either.
      expect(getToolUseModels).not.toHaveBeenCalled();
    });

    it('trusts the server over the id regex for a family the regex predates', async () => {
      // `phi4-mini` reports Ollama's `tools` capability but matches no
      // TOOL_USE_RE alternative — the mislabel this union exists to fix.
      getToolUseModels.mockResolvedValue({
        models: [{ providerId: 'ollama', id: 'phi4-mini:latest', toolUse: true }],
      });
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'phi4-mini:latest',
        availableModels: ['phi4-mini:latest', 'gemma3:4b'],
        highlightToolUse: true,
      });
      await waitFor(() =>
        expect(modelLabels()).toEqual(['phi4-mini:latest · 🔧 tool use', 'gemma3:4b · ⚠ no known tool use']));
      expect(screen.queryByText(/recognized tool-calling model/i)).not.toBeInTheDocument();
    });

    it('asserts nothing until the capability scan settles', async () => {
      let resolveScan;
      getToolUseModels.mockReturnValue(new Promise((r) => { resolveScan = r; }));
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'phi4-mini:latest',
        availableModels: ['phi4-mini:latest'],
        highlightToolUse: true,
      });
      // Mid-scan the regex would say "⚠ no known tool use" — showing it here
      // just to retract it a beat later is the bug, so hold the annotation.
      expect(modelLabels()).toEqual(['phi4-mini:latest']);
      expect(screen.queryByText(/recognized tool-calling model/i)).not.toBeInTheDocument();

      resolveScan({ models: [{ providerId: 'ollama', id: 'phi4-mini:latest', toolUse: true }] });
      await waitFor(() => expect(modelLabels()).toEqual(['phi4-mini:latest · 🔧 tool use']));
    });

    it('falls back to the id regex when the capability scan fails', async () => {
      getToolUseModels.mockRejectedValue(new Error('ollama down'));
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'gemma3:4b',
        availableModels: ['qwen3.6:35b', 'gemma3:4b'],
        highlightToolUse: true,
      });
      // A failed scan still settles, so the annotation appears — regex-only is
      // the best answer available, not a reason to go silent forever.
      await waitFor(() =>
        expect(modelLabels()).toEqual(['qwen3.6:35b · 🔧 tool use', 'gemma3:4b · ⚠ no known tool use']));
      expect(screen.getByText(/recognized tool-calling model/i)).toBeInTheDocument();
    });
  });

  describe('effort select', () => {
    const AGY = [{
      id: 'antigravity-cli',
      name: 'Antigravity',
      command: 'agy',
      models: ['gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6'],
    }];

    const renderEffort = (props = {}) => renderSelector({
      providers: AGY,
      selectedProviderId: 'antigravity-cli',
      selectedModel: 'gemini-3.6-flash',
      availableModels: ['gemini-3.6-flash', 'gemini-3.1-pro', 'claude-sonnet-4-6'],
      effort: '',
      onEffortChange: () => {},
      ...props,
    });

    it('is absent unless onEffortChange is supplied', () => {
      renderEffort({ effort: undefined, onEffortChange: undefined });
      expect(screen.getAllByRole('combobox')).toHaveLength(2);
      expect(screen.queryByLabelText('Thinking effort')).not.toBeInTheDocument();
    });

    it('renders a labeled effort select for an effort-capable provider', () => {
      renderEffort();
      const effortSelect = screen.getByLabelText('Thinking effort');
      const options = [...effortSelect.querySelectorAll('option')].map((o) => o.value);
      expect(options).toEqual(['', 'low', 'medium', 'high']);
    });

    it('narrows the options to the tiers the selected Antigravity model offers', () => {
      // agy rejects `--model gemini-3.1-pro --effort medium`.
      renderEffort({ selectedModel: 'gemini-3.1-pro' });
      const options = [...screen.getByLabelText('Thinking effort').querySelectorAll('option')].map((o) => o.value);
      expect(options).toEqual(['', 'low', 'high']);
    });

    it('still offers the full ladder on the configured-default sentinel', () => {
      // The sentinel is the shipped agy defaultModel, so the picker auto-selects
      // it — the effort control must not hide until a model is chosen.
      renderEffort({ selectedModel: 'antigravity-configured-default' });
      const options = [...screen.getByLabelText('Thinking effort').querySelectorAll('option')].map((o) => o.value);
      expect(options).toEqual(['', 'low', 'medium', 'high']);
    });

    it('hides itself (label and all) for an Antigravity model with no tiers', () => {
      renderEffort({ selectedModel: 'claude-sonnet-4-6' });
      expect(screen.queryByLabelText('Thinking effort')).not.toBeInTheDocument();
      expect(screen.queryByText('Thinking effort')).not.toBeInTheDocument();
    });

    it('hides itself for a provider with no effort control', () => {
      renderSelector({
        providers: [{ id: 'ollama', name: 'Ollama', endpoint: 'http://localhost:11434' }],
        selectedProviderId: 'ollama',
        selectedModel: 'qwen3',
        availableModels: ['qwen3'],
        effort: '',
        onEffortChange: () => {},
      });
      expect(screen.queryByLabelText('Thinking effort')).not.toBeInTheDocument();
    });

    it('reports the picked level to onEffortChange', () => {
      const onEffortChange = vi.fn();
      renderEffort({ onEffortChange });
      fireEvent.change(screen.getByLabelText('Thinking effort'), { target: { value: 'high' } });
      expect(onEffortChange).toHaveBeenCalledWith('high');
    });
  });
});
