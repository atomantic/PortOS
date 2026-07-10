import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api', () => ({ getAiAssignments: vi.fn() }));
vi.mock('../../services/apiCreativeDirector.js', () => ({ updateCreativeDirectorProject: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import CreativeDirectorModelsDrawer from './CreativeDirectorModelsDrawer.jsx';
import { getAiAssignments } from '../../services/api';
import { updateCreativeDirectorProject } from '../../services/apiCreativeDirector.js';

const ASSIGNMENTS = {
  providers: [
    { id: 'agent-a', name: 'Agent A', type: 'cli', enabled: true, defaultModel: 'a-default', models: ['a-default', 'a-big'] },
    { id: 'vlm-x', name: 'VLM X', type: 'api', enabled: true, defaultModel: 'llava', models: ['llava', 'moondream'] },
  ],
  assignments: [
    { id: 'settings.creativeDirector.treatment', providerTypes: ['cli', 'tui'], providerId: '', model: '' },
    { id: 'settings.creativeDirector.plan', providerTypes: ['cli', 'tui'], providerId: '', model: '' },
    { id: 'settings.creativeDirector.evaluation', providerTypes: ['api'], providerId: '', model: '' },
  ],
};

const renderDrawer = (project, props = {}) => render(
  <MemoryRouter>
    <CreativeDirectorModelsDrawer open onClose={vi.fn()} project={project} {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  getAiAssignments.mockResolvedValue(ASSIGNMENTS);
});

describe('CreativeDirectorModelsDrawer', () => {
  it('seeds the model select from an existing project override', async () => {
    renderDrawer({ id: 'cd-1', name: 'Demo', modelOverrides: { treatment: { providerId: 'agent-a', model: 'a-big' } } });
    await waitFor(() => expect(screen.getByLabelText('Treatment provider')).toBeTruthy());
    expect(screen.getByLabelText('Treatment provider').value).toBe('agent-a');
    expect(screen.getByLabelText('Treatment model').value).toBe('a-big');
  });

  it('saves only stages that name a provider, omitting inherited ones', async () => {
    updateCreativeDirectorProject.mockResolvedValue({ modelOverrides: { evaluation: { providerId: 'vlm-x', model: 'moondream' } } });
    const onSaved = vi.fn();
    renderDrawer({ id: 'cd-1', name: 'Demo', modelOverrides: {} }, { onSaved });

    await waitFor(() => expect(screen.getByLabelText('Scene evaluation provider')).toBeTruthy());
    // Pick a provider for evaluation only; treatment/plan stay on "Inherit global".
    fireEvent.change(screen.getByLabelText('Scene evaluation provider'), { target: { value: 'vlm-x' } });
    // Provider switch seeds the default model; override it explicitly.
    fireEvent.change(screen.getByLabelText('Scene evaluation model'), { target: { value: 'moondream' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => expect(updateCreativeDirectorProject).toHaveBeenCalled());
    const [id, patch] = updateCreativeDirectorProject.mock.calls[0];
    expect(id).toBe('cd-1');
    expect(patch).toEqual({ modelOverrides: { evaluation: { providerId: 'vlm-x', model: 'moondream' } } });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ evaluation: { providerId: 'vlm-x', model: 'moondream' } }));
  });

  it('disables Save until a stage is edited', async () => {
    renderDrawer({ id: 'cd-1', name: 'Demo', modelOverrides: {} });
    await waitFor(() => expect(screen.getByRole('button', { name: /Save/i })).toBeTruthy());
    expect(screen.getByRole('button', { name: /Save/i }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Treatment provider'), { target: { value: 'agent-a' } });
    expect(screen.getByRole('button', { name: /Save/i }).disabled).toBe(false);
  });
});
