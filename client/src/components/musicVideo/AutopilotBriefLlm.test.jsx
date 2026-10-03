/**
 * The autopilot brief's direction/planning LLM (#9545), over the REAL provider
 * hook and selector with only the provider list doubled: the picker is
 * available before kickoff, a pick (provider + model + effort) is what Save
 * sends, a reload restores it, a dirty selection cannot start the kickoff, and
 * the route each stage last ran on is shown. Nothing here calls a provider.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  getProviders: vi.fn(),
}));
vi.mock('../../services/apiMusicVideo.js', () => ({
  startMusicVideoProduction: vi.fn(), resumeMusicVideoProduction: vi.fn(), stopMusicVideoProduction: vi.fn(), cancelMusicVideoProduction: vi.fn(),
}));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import AutopilotPanel from './AutopilotPanel.jsx';
import * as api from '../../services/api';

const PROVIDERS = [
  { id: 'claude-tui', name: 'Claude TUI', type: 'tui', enabled: true, command: 'claude', models: ['opus', 'sonnet'], defaultModel: 'opus' },
  { id: 'cloud-api', name: 'Cloud API', type: 'api', enabled: true, models: ['big'], defaultModel: 'big' },
];
const IDLE_PRODUCTION = { busy: false, start: vi.fn(), resume: vi.fn(), stop: vi.fn(), cancel: vi.fn() };
const BASE = { tools: ['image:local'], guidance: 'Moody neon', budgetUsd: null, checkins: { castAndSets: 'review' } };

// The server merges a patch per sub-field and returns the stored brief; do the same here.
function Harness({ initial, onSave }) {
  const [project, setProject] = useState({ id: 'mv-1', trackId: 't1', automation: initial });
  const save = (patch) => {
    onSave(patch);
    const { llm, ...rest } = { ...project.automation, ...patch };
    setProject((p) => ({ ...p, automation: { ...rest, ...(llm ? { llm } : {}) } }));
    return Promise.resolve();
  };
  return <AutopilotPanel project={project} production={IDLE_PRODUCTION} onSave={save} onKickoff={vi.fn()} kickoffBusy={false} />;
}

// The production form below also renders provider pickers; scope to the brief's.
const picker = async () => within(await screen.findByTestId('mv-auto-mv-1-llm'));
// The production form's provider hooks fetch on mount; settle them inside act.
const renderBrief = async (initial, onSave = vi.fn()) => {
  render(<Harness initial={initial} onSave={onSave} />);
  await act(async () => {});
};
const providerSelect = async () => (await picker()).findByLabelText('Direction & planning LLM');

beforeEach(() => {
  vi.clearAllMocks();
  api.getProviders.mockResolvedValue({ activeProvider: 'cloud-api', providers: PROVIDERS });
});

describe('AutopilotPanel direction LLM (#9545)', () => {
  it('offers Auto before kickoff, saves a provider + model + effort pick, and shows it with the kickoff available again', async () => {
    const onSave = vi.fn();
    await renderBrief(BASE, onSave);
    // Before editing: the saved brief names Auto and the kickoff is available.
    expect(screen.getByText(/Direction LLM: Auto/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Analyze & plan/ })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit brief' }));
    const provider = await providerSelect();
    await waitFor(() => expect(provider).toHaveValue(''));
    expect(screen.getByRole('option', { name: /Auto — a TUI provider/ })).toBeInTheDocument();

    fireEvent.change(provider, { target: { value: 'claude-tui' } });
    fireEvent.change(await (await picker()).findByLabelText('Model'), { target: { value: 'sonnet' } });
    fireEvent.change(await (await picker()).findByLabelText('Thinking effort'), { target: { value: 'high' } });

    // A dirty selection cannot start the kickoff: the editor replaces the kickoff control until saved.
    expect(screen.queryByRole('button', { name: /Analyze & plan/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ llm: { providerId: 'claude-tui', model: 'sonnet', effort: 'high' } });

    expect(await screen.findByText(/Direction LLM: claude-tui · sonnet · high/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Analyze & plan/ })).toBeEnabled();
  });

  it('restores a saved pin on reload, and sends an explicit null when the director goes back to Auto', async () => {
    const onSave = vi.fn();
    await renderBrief({ ...BASE, llm: { providerId: 'claude-tui', model: 'sonnet', effort: 'low' } }, onSave);
    fireEvent.click(screen.getByRole('button', { name: 'Edit brief' }));

    const provider = await providerSelect();
    await waitFor(() => expect(provider).toHaveValue('claude-tui'));
    expect(await (await picker()).findByLabelText('Model')).toHaveValue('sonnet');
    expect(await (await picker()).findByLabelText('Thinking effort')).toHaveValue('low');

    fireEvent.change(provider, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].llm).toBeNull();
    expect(await screen.findByText(/Direction LLM: Auto/)).toBeInTheDocument();
  });

  it('says so, instead of silently keeping the pin, when the saved provider is gone', async () => {
    const onSave = vi.fn();
    await renderBrief({ ...BASE, llm: { providerId: 'deleted-provider', model: null, effort: null } }, onSave);
    fireEvent.click(screen.getByRole('button', { name: 'Edit brief' }));

    expect(await (await picker()).findByRole('status')).toHaveTextContent(/“deleted-provider” is no longer available/);
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // The unavailable pin is cleared, not re-sent.
    expect(onSave.mock.calls[0][0].llm).toBeNull();
  });

  it('pins a model per stage from the collapsed "Models per stage" section, and clears a saved stage with null', async () => {
    const onSave = vi.fn();
    await renderBrief({ ...BASE, llmStages: { castAndSets: { providerId: 'cloud-api', model: 'big', effort: null } } }, onSave);
    expect(screen.getByText(/Per stage: Cast & sets direction → cloud-api · big/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit brief' }));

    // A saved stage pin opens the section; only the stages a saved project runs are offered.
    const section = within(await screen.findByTestId('mv-auto-mv-1-llm-stages'));
    expect(section.getByRole('button', { name: /Models per stage/ })).toHaveAttribute('aria-expanded', 'true');
    expect(section.queryByLabelText('Lyrics draft')).not.toBeInTheDocument();
    const planRow = within(await screen.findByTestId('mv-auto-mv-1-stage-plan-llm'));
    const plan = await planRow.findByLabelText('Shot plan');
    expect(planRow.getByRole('option', { name: 'Default (use direction LLM)' })).toBeInTheDocument();
    fireEvent.change(plan, { target: { value: 'claude-tui' } });
    fireEvent.change(await planRow.findByLabelText('Model'), { target: { value: 'opus' } });

    const castRow = within(screen.getByTestId('mv-auto-mv-1-stage-castAndSets-llm'));
    const cast = await castRow.findByLabelText('Cast & sets direction');
    await waitFor(() => expect(cast).toHaveValue('cloud-api'));
    fireEvent.change(cast, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].llmStages).toEqual({ castAndSets: null, plan: { providerId: 'claude-tui', model: 'opus', effort: null } });
  });

  it('shows the route each stage last ran on, including a pin it replaced', async () => {
    const routes = {
      plan: { providerId: 'claude-tui', model: 'opus', effort: 'high', transport: 'tui', source: 'tui-preferred' },
      castAndSets: { providerId: 'cloud-api', model: 'big', transport: 'api', source: 'active', requestedProviderId: 'deleted-provider' },
    };
    await renderBrief({ ...BASE, routes });
    expect(screen.getByText('Shot planning ran on claude-tui · opus · high (TUI)')).toBeInTheDocument();
    expect(screen.getByText(/Cast & Sets direction ran on cloud-api · big \(API\) — replaced the unavailable deleted-provider/)).toBeInTheDocument();
  });

  it('loads a brief saved before the pin existed with no pin and no route lines', async () => {
    await renderBrief(BASE);
    expect(screen.getByText(/Direction LLM: Auto/)).toBeInTheDocument();
    expect(screen.queryByText(/ran on/)).not.toBeInTheDocument();
  });
});
