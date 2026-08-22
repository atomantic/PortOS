/**
 * The Timeline tab's expanded per-app rows resolve provider DISPLAY NAMES (#4783).
 *
 * `WorkflowTab` rendered `PerAppOverrideList` without a `providers` list, so the
 * same pin read as `claude-ollama-tui` here and "Claude (ollama)" on the Schedule
 * tab. The list is owned by ChiefOfStaff and already threaded to ScheduleTab, so
 * the fix is to hand it to this tab too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = {
  getCosWorkflow: vi.fn(),
  updateAppTaskTypeOverride: vi.fn(),
  bulkUpdateAppTaskTypeOverride: vi.fn(),
};
vi.mock('../../../services/api', () => api);

const WorkflowTab = (await import('./WorkflowTab')).default;

const APPS = [{ id: 'app-1', name: 'Acme', icon: 'package' }];
const PROVIDERS = [
  { id: 'opencode-llama-tui', name: 'OpenCode (llama)', models: ['qwen-a'] },
  { id: 'claude-ollama-tui', name: 'Claude (ollama)', models: ['qwen-b'] },
];

const NOW = new Date('2026-08-22T00:00:00Z');
const GRAPH = {
  timezone: 'UTC',
  timeline: {
    startAt: NOW.toISOString(),
    endAt: new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString(),
    occurrences: [{ nodeId: 'task:ux', at: NOW.toISOString() }],
    windows: [],
  },
  nodes: [{
    id: 'task:ux',
    kind: 'task',
    label: 'ux',
    enabled: true,
    schedule: { type: 'daily' },
    totalAppCount: 1,
    enabledAppCount: 1,
    // The task's own Schedule pin, which an app inherits when it pins nothing.
    providerId: 'opencode-llama-tui',
    model: 'qwen-a',
    appOverrides: { 'app-1': { enabled: true, providerId: 'claude-ollama-tui', model: 'qwen-b' } },
  }],
  edges: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosWorkflow.mockResolvedValue(GRAPH);
});
afterEach(cleanup);

const renderTab = async (providers) => {
  await act(async () => {
    render(<MemoryRouter><WorkflowTab apps={APPS} providers={providers} /></MemoryRouter>);
  });
  const expand = await screen.findByRole('button', { name: /show app overrides for ux/i });
  fireEvent.click(expand);
};

describe('WorkflowTab per-app override rows', () => {
  it('renders the app pin with the provider display name, not the raw id', async () => {
    await renderTab(PROVIDERS);
    const pin = screen.getByLabelText('Provider for Acme');
    expect(pin).toHaveValue('claude-ollama-tui');
    expect(screen.getByRole('option', { name: 'Claude (ollama)' })).toBeInTheDocument();
    // …and the inherited task pin reads by name too.
    expect(screen.getByRole('option', { name: 'Inherit (OpenCode (llama) / qwen-a)' })).toBeInTheDocument();
  });

  it('writes the pin from the Timeline tab through the shared override mutation', async () => {
    api.updateAppTaskTypeOverride.mockResolvedValue({ success: true });
    await renderTab(PROVIDERS);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Provider for Acme'), { target: { value: '' } });
    });
    expect(api.updateAppTaskTypeOverride).toHaveBeenCalledWith(
      'app-1', 'ux', { providerId: null, model: null }, { silent: true }
    );
  });
});
