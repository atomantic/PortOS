import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({ getAiAssignments: vi.fn(), updateAiAssignment: vi.fn() }));
vi.mock('../../services/apiLocalLlm', () => ({ getVisionModels: vi.fn(), getToolUseModels: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import AiAssignmentsTab from './AiAssignmentsTab.jsx';
import { getAiAssignments, updateAiAssignment } from '../../services/api';
import { getVisionModels, getToolUseModels } from '../../services/apiLocalLlm';
import { __resetToolUseModelIdsCache } from '../../hooks/useToolUseModelIds.js';

// Mirrors the `getAiAssignments` payload: `needsTools` marks the agent-harness
// rows, `modelFilter: 'vision'` the direct vision call. `gemma2:9b` matches no
// tool-use family; `qwen3.6:35b` does.
const PROVIDERS = [
  {
    id: 'ollama',
    name: 'Ollama',
    type: 'api',
    enabled: true,
    defaultModel: 'gemma2:9b',
    models: ['gemma2:9b', 'qwen3.6:35b'],
    ollamaBacked: true,
  },
  { id: 'openai', name: 'OpenAI', type: 'api', enabled: true, defaultModel: 'gpt-4o', models: ['gpt-4o'], ollamaBacked: false },
];

const entry = (over) => ({
  area: 'Creative Director',
  label: 'Production planning model',
  source: 'settings.creativeDirector.plan',
  scope: 'global',
  assignmentType: 'Creative workflows',
  editable: true,
  providerEditable: true,
  modelEditable: true,
  providerTypes: ['api'],
  providerOptions: null,
  modelOptions: null,
  modelFilter: null,
  needsTools: false,
  link: null,
  notes: '',
  providerId: '',
  model: '',
  effort: '',
  effortEditable: false,
  ...over,
});

const payload = (assignments) => ({ providers: PROVIDERS, activeProvider: 'openai', assignments });

const renderTab = () => render(<MemoryRouter><AiAssignmentsTab /></MemoryRouter>);

const WARNING = /recognized tool-calling model/i;

beforeEach(() => {
  vi.clearAllMocks();
  __resetToolUseModelIdsCache();
  getVisionModels.mockResolvedValue({ models: [] });
  // Nothing authoritative by default, so the id regex alone decides.
  getToolUseModels.mockResolvedValue({ models: [] });
});

describe('AiAssignmentsTab tool-use warning', () => {
  it('warns on an agent row pinned to a local model with no known tool use', async () => {
    // The gap this closes: the Creative Director drawer warned about this exact
    // pin while its own "Also editable from AI Assignments" link led to a table
    // that let the user set it with no annotation at all.
    getAiAssignments.mockResolvedValue(payload([
      entry({ id: 'settings.creativeDirector.plan', needsTools: true, providerId: 'ollama', model: 'gemma2:9b' }),
    ]));
    renderTab();
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
  });

  it('leaves a non-agent row unflagged on the same model', async () => {
    // Scene evaluation is a direct vision call — a non-tool model is expected
    // there, so `needsTools` (not the model id) has to gate the warning.
    getAiAssignments.mockResolvedValue(payload([
      entry({ id: 'settings.creativeDirector.evaluation', label: 'Scene evaluation vision model', modelFilter: 'vision', providerId: 'ollama', model: 'gemma2:9b' }),
    ]));
    renderTab();
    await waitFor(() => expect(screen.getByLabelText('Model for Scene evaluation vision model')).toBeTruthy());
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('does not warn when the agent row is pinned to a tool-capable model', async () => {
    getAiAssignments.mockResolvedValue(payload([
      entry({ id: 'settings.creativeDirector.plan', needsTools: true, providerId: 'ollama', model: 'qwen3.6:35b' }),
    ]));
    renderTab();
    await waitFor(() => expect(getToolUseModels).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText('Model for Production planning model')).toBeTruthy());
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('warns on a blank model pin, which runs the provider default', async () => {
    // "Default / auto" is not a no-op: the run resolves ollama's own
    // `gemma2:9b`, so the row looks unset while being just as wedged.
    getAiAssignments.mockResolvedValue(payload([
      entry({ id: 'settings.creativeDirector.plan', needsTools: true, providerId: 'ollama', model: '' }),
    ]));
    renderTab();
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
    expect(screen.getByText(/this provider’s default/)).toBeInTheDocument();
  });

  it('clears the warning for a model the backend reports as tool-capable', async () => {
    getToolUseModels.mockResolvedValue({ models: [{ providerId: 'ollama', id: 'gemma2:9b', toolUse: true }] });
    getAiAssignments.mockResolvedValue(payload([
      entry({ id: 'settings.creativeDirector.plan', needsTools: true, providerId: 'ollama', model: 'gemma2:9b' }),
    ]));
    renderTab();
    await waitFor(() => expect(getToolUseModels).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText('Model for Production planning model')).toBeTruthy());
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('annotates each model option of an agent row with its tool-use marker', async () => {
    getAiAssignments.mockResolvedValue(payload([
      entry({ id: 'settings.creativeDirector.plan', needsTools: true, providerId: 'ollama', model: 'qwen3.6:35b' }),
    ]));
    renderTab();
    const select = await screen.findByLabelText('Model for Production planning model');
    await waitFor(() => expect(select.textContent).toMatch(/🔧 tool use/));
    expect(select.textContent).toMatch(/⚠ no known tool use/);
  });

  it('does not annotate a non-agent row', async () => {
    getAiAssignments.mockResolvedValue(payload([
      entry({ id: 'settings.messages.triage', area: 'Messages', label: 'Triage assistant', providerId: 'ollama', model: 'gemma2:9b' }),
    ]));
    renderTab();
    const select = await screen.findByLabelText('Model for Triage assistant');
    await waitFor(() => expect(getToolUseModels).toHaveBeenCalled());
    expect(select.textContent).not.toMatch(/tool use/);
  });

  it('flags an ollama-backed wrapper CLI whose id and name say nothing about ollama', async () => {
    // Only the server-resolved `ollamaBacked` flag identifies this provider —
    // the curated payload carries no envVars/endpoint for the client to sniff,
    // and this wrapper class is exactly the one the incident ran on.
    getAiAssignments.mockResolvedValue({
      providers: [{ id: 'local-agent', name: 'Local Agent', type: 'tui', enabled: true, defaultModel: 'gemma2:9b', models: ['gemma2:9b'], ollamaBacked: true }],
      activeProvider: 'local-agent',
      assignments: [entry({ id: 'settings.creativeDirector.plan', needsTools: true, providerTypes: ['cli', 'tui'], providerId: 'local-agent', model: 'gemma2:9b' })],
    });
    renderTab();
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
  });
});

describe('AiAssignmentsTab provider chips', () => {
  // TabPills renders the count in its own span right after the label, and a zero
  // count renders no span at all (leaving a bare 'Ollama'). Whether the two join
  // with a space depends on what the test DOM reports for the span's `display`:
  // dom-accessibility-api inserts one for anything it does not see as inline, so
  // happy-dom — which serves no UA defaults and reports `''` — gives 'Ollama 1'
  // where jsdom's `'inline'` gave 'Ollama1' (#6144). A real browser blockifies the
  // flex item and also spaces it, so match on the name with whitespace collapsed
  // rather than pinning one engine's join.
  const squash = (text) => text.replace(/\s+/g, '');
  const chipName = (label, count = '') => (name) => squash(name) === squash(`${label}${count}`);
  const chip = (label, count = '') => screen.getByRole('button', { name: chipName(label, count) });

  // Rendered per test rather than in a beforeEach: the mount's async load has to
  // settle inside the test body, or the suite's act(...) guard fails it.
  const renderRows = () => {
    getAiAssignments.mockResolvedValue(payload([
      entry({ id: 'a', label: 'Alpha row', providerId: 'ollama', model: 'gemma2:9b' }),
      entry({ id: 'b', label: 'Bravo row', providerId: 'openai', model: 'gpt-4o' }),
      entry({ id: 'c', label: 'Charlie row', providerId: '', model: '' }),
    ]));
    renderTab();
  };

  it('filters the table to one provider when its chip is clicked, and clears on a second click', async () => {
    renderRows();
    const ollama = await screen.findByRole('button', { name: chipName('Ollama', 1) });

    await userEvent.click(ollama);
    expect(ollama).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Alpha row')).toBeInTheDocument();
    expect(screen.queryByText('Bravo row')).not.toBeInTheDocument();
    expect(screen.queryByText('Charlie row')).not.toBeInTheDocument();

    await userEvent.click(ollama);
    expect(ollama).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Bravo row')).toBeInTheDocument();
  });

  it('gives rows with no provider their own chip', async () => {
    renderRows();
    await userEvent.click(await screen.findByRole('button', { name: chipName('Default / unset', 1) }));
    expect(screen.getByText('Charlie row')).toBeInTheDocument();
    expect(screen.queryByText('Alpha row')).not.toBeInTheDocument();
  });

  it('clears the filter from the All chip', async () => {
    renderRows();
    await userEvent.click(await screen.findByRole('button', { name: chipName('Ollama', 1) }));
    await userEvent.click(chip('All', 3));
    expect(screen.getByText('Bravo row')).toBeInTheDocument();
    expect(screen.getByText('Charlie row')).toBeInTheDocument();
  });

  it('recounts chips against the other filters and keeps the selected chip clickable at zero', async () => {
    // The chip counts have to describe the rows the search left behind, or the
    // numbers stop matching the table; and a selection the search zeroes out
    // must stay on screen or there is no way to undo it.
    renderRows();
    await userEvent.click(await screen.findByRole('button', { name: chipName('Ollama', 1) }));
    await userEvent.type(screen.getByLabelText('Search assignments'), 'Bravo');

    expect(chip('OpenAI', 1)).toBeInTheDocument();
    await userEvent.click(chip('Ollama'));
    expect(screen.getByText('Bravo row')).toBeInTheDocument();
  });
});

describe('AiAssignmentsTab assignment management', () => {
  it('filters persisted assignments by assignment type', async () => {
    getAiAssignments.mockResolvedValue(payload([
      entry({ id: 'creative', label: 'Creative row', assignmentType: 'Creative workflows' }),
      entry({ id: 'scheduled', label: 'Scheduled row', area: 'Chief of Staff', assignmentType: 'Scheduled tasks' }),
    ]));
    renderTab();

    await userEvent.selectOptions(await screen.findByLabelText('Filter by assignment type'), 'Scheduled tasks');
    expect(screen.getByText('Scheduled row')).toBeInTheDocument();
    expect(screen.queryByText('Creative row')).not.toBeInTheDocument();
  });

  it('replaces an exact model mapping within the same provider', async () => {
    const before = entry({ id: 'creative', label: 'Creative row', providerId: 'ollama', model: 'gemma2:9b' });
    const after = { ...before, model: 'qwen3.6:35b' };
    getAiAssignments.mockResolvedValue(payload([before]));
    updateAiAssignment.mockResolvedValue(payload([after]));
    renderTab();

    await userEvent.selectOptions(await screen.findByLabelText('Replace from provider'), 'ollama');
    await userEvent.selectOptions(screen.getByLabelText('Replace from model'), 'gemma2:9b');
    await userEvent.selectOptions(screen.getByLabelText('Replace with provider'), 'ollama');
    await userEvent.selectOptions(screen.getByLabelText('Replace with model'), 'qwen3.6:35b');
    await userEvent.click(screen.getByRole('button', { name: 'Replace all matches' }));

    await waitFor(() => expect(updateAiAssignment).toHaveBeenCalledWith(
      'creative',
      { providerId: 'ollama', model: 'qwen3.6:35b' },
      { silent: true },
    ));
  });

  it('saves reasoning effort on scheduled assignments that support it', async () => {
    const providers = [
      ...PROVIDERS,
      { id: 'claude-code', name: 'Claude Code', type: 'cli', enabled: true, defaultModel: 'opus', models: ['opus'], ollamaBacked: false },
    ];
    const before = entry({
      id: 'cos.job.audit',
      area: 'Chief of Staff',
      assignmentType: 'Scheduled tasks',
      label: 'Scheduled job: Audit',
      providerId: 'claude-code',
      model: 'opus',
      providerTypes: ['cli', 'tui'],
      needsTools: true,
      effortEditable: true,
    });
    const after = { ...before, effort: 'xhigh' };
    getAiAssignments.mockResolvedValue({ providers, activeProvider: 'claude-code', assignments: [before] });
    updateAiAssignment.mockResolvedValue({ providers, activeProvider: 'claude-code', assignments: [after] });
    renderTab();

    await userEvent.selectOptions(await screen.findByLabelText('Effort for Scheduled job: Audit'), 'xhigh');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateAiAssignment).toHaveBeenCalledWith(
      'cos.job.audit',
      { providerId: 'claude-code', model: 'opus', effort: 'xhigh' },
      { silent: true },
    ));
  });

  it('uses the active provider for an inherited scheduled effort pin', async () => {
    const providers = [
      ...PROVIDERS,
      { id: 'claude-code', name: 'Claude Code', type: 'cli', enabled: true, defaultModel: 'opus', models: ['opus'], ollamaBacked: false },
    ];
    getAiAssignments.mockResolvedValue({
      providers,
      activeProvider: 'claude-code',
      assignments: [entry({
        id: 'cos.job.audit',
        area: 'Chief of Staff',
        assignmentType: 'Scheduled tasks',
        label: 'Scheduled job: Audit',
        providerId: '',
        model: '',
        effort: 'high',
        providerTypes: ['cli', 'tui'],
        needsTools: true,
        effortEditable: true,
      })],
    });
    renderTab();

    expect(await screen.findByLabelText('Effort for Scheduled job: Audit')).toHaveValue('high');
  });

  it('seeds a compatible model when bulk-replacing a vision assignment with the target default', async () => {
    const providers = [
      ...PROVIDERS,
      { id: 'lmstudio', name: 'LM Studio', type: 'api', enabled: true, defaultModel: 'text-model', models: ['text-model', 'qwen2.5-vl'], ollamaBacked: false },
    ];
    const before = entry({
      id: 'settings.creativeDirector.evaluation',
      label: 'Scene evaluation vision model',
      providerId: 'openai',
      model: 'gpt-4o',
      modelFilter: 'vision',
    });
    const after = { ...before, providerId: 'lmstudio', model: 'qwen2.5-vl' };
    getVisionModels.mockResolvedValue({ models: [{ providerId: 'lmstudio', id: 'qwen2.5-vl' }] });
    getAiAssignments.mockResolvedValue({ providers, activeProvider: 'openai', assignments: [before] });
    updateAiAssignment.mockResolvedValue({ providers, activeProvider: 'openai', assignments: [after] });
    renderTab();

    await userEvent.selectOptions(await screen.findByLabelText('Replace from provider'), 'openai');
    await userEvent.selectOptions(screen.getByLabelText('Replace with provider'), 'lmstudio');
    await userEvent.click(screen.getByRole('button', { name: 'Replace all matches' }));

    await waitFor(() => expect(updateAiAssignment).toHaveBeenCalledWith(
      'settings.creativeDirector.evaluation',
      { providerId: 'lmstudio', model: 'qwen2.5-vl' },
      { silent: true },
    ));
  });
});
