import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({ getAiAssignments: vi.fn(), updateAiAssignment: vi.fn() }));
vi.mock('../../services/apiLocalLlm', () => ({ getVisionModels: vi.fn(), getToolUseModels: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import AiAssignmentsTab from './AiAssignmentsTab.jsx';
import { getAiAssignments } from '../../services/api';
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
