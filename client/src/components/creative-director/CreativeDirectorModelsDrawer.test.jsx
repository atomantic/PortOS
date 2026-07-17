import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api', () => ({ getAiAssignments: vi.fn(), updateAiAssignment: vi.fn() }));
vi.mock('../../services/apiCreativeDirector.js', () => ({ updateCreativeDirectorProject: vi.fn() }));
vi.mock('../../services/apiLocalLlm', () => ({ getVisionModels: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import CreativeDirectorModelsDrawer from './CreativeDirectorModelsDrawer.jsx';
import { getAiAssignments, updateAiAssignment } from '../../services/api';
import { updateCreativeDirectorProject } from '../../services/apiCreativeDirector.js';
import { getVisionModels } from '../../services/apiLocalLlm';

const ASSIGNMENTS = {
  providers: [
    { id: 'agent-a', name: 'Agent A', type: 'cli', enabled: true, defaultModel: 'a-default', models: ['a-default', 'a-big'] },
    { id: 'vlm-x', name: 'VLM X', type: 'api', enabled: true, defaultModel: 'llava', models: ['llava', 'moondream'] },
    {
      id: 'ollama',
      name: 'Ollama',
      type: 'api',
      enabled: true,
      defaultModel: 'gemma4:26b',
      models: ['qwen2.5vl:latest', 'llava:latest', 'gemma4:26b', 'llama3.2:latest'],
    },
  ],
  assignments: [
    { id: 'settings.creativeDirector.treatment', providerTypes: ['cli', 'tui'], providerId: '', model: '' },
    { id: 'settings.creativeDirector.plan', providerTypes: ['cli', 'tui'], providerId: '', model: '' },
    {
      id: 'settings.creativeDirector.evaluation',
      providerTypes: ['api'],
      providerId: '',
      model: '',
      modelFilter: 'vision',
    },
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
  // Default: the local backends report no vision models, so the id regex alone
  // decides — the pre-`useVisionModelIds` behavior.
  getVisionModels.mockResolvedValue({ models: [] });
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

  it('restricts Scene evaluation models to vision-capable ids for local Ollama', async () => {
    renderDrawer({ id: 'cd-1', name: 'Demo', modelOverrides: {} });
    await waitFor(() => expect(screen.getByLabelText('Scene evaluation provider')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Scene evaluation provider'), { target: { value: 'ollama' } });

    const modelSelect = screen.getByLabelText('Scene evaluation model');
    const optionValues = Array.from(modelSelect.querySelectorAll('option')).map((o) => o.value);
    // Empty "Provider default / auto" sentinel stays; text-only local models drop out.
    expect(optionValues).toContain('');
    expect(optionValues).toContain('qwen2.5vl:latest');
    expect(optionValues).toContain('llava:latest');
    expect(optionValues).not.toContain('gemma4:26b');
    expect(optionValues).not.toContain('llama3.2:latest');
    // Text-only default is replaced by the first eligible VLM.
    expect(modelSelect.value).toBe('qwen2.5vl:latest');
  });

  // The reported bug: the client id regex knows `gemma-3` but not `gemma4`, so a
  // user whose only installed VLMs are gemma4/qwen3.6 saw an EMPTY Scene
  // evaluation model picker. The server already knows better via Ollama's
  // /api/show capabilities, so its verdict is unioned in.
  it('offers vision models the id regex misses but the server reports as vision-capable', async () => {
    getVisionModels.mockResolvedValue({
      models: [
        { providerId: 'ollama', backend: 'ollama', id: 'gemma4:26b', vision: true },
        { providerId: 'ollama', backend: 'ollama', id: 'llama3.2:latest', vision: true },
      ],
    });
    renderDrawer({ id: 'cd-1', name: 'Demo', modelOverrides: {} });
    await waitFor(() => expect(screen.getByLabelText('Scene evaluation provider')).toBeTruthy());
    await waitFor(() => expect(getVisionModels).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Scene evaluation provider'), { target: { value: 'ollama' } });

    const optionValues = Array.from(
      screen.getByLabelText('Scene evaluation model').querySelectorAll('option'),
    ).map((o) => o.value);
    // Server-reported ids the regex would have hidden.
    expect(optionValues).toContain('gemma4:26b');
    expect(optionValues).toContain('llama3.2:latest');
    // Union, not replacement — regex-matched ids the server didn't list survive.
    expect(optionValues).toContain('qwen2.5vl:latest');
    expect(optionValues).toContain('llava:latest');
  });

  it('does not fetch vision models while closed', async () => {
    // The drawer stays mounted on the page; the endpoint asks Ollama for every
    // installed model's capabilities, so a closed drawer must not pay for it.
    render(
      <MemoryRouter>
        <CreativeDirectorModelsDrawer open={false} onClose={vi.fn()} project={{ id: 'cd-1', name: 'Demo' }} />
      </MemoryRouter>,
    );
    // Assert directly rather than through waitFor: `render` already flushes
    // effects inside act(), so both fetches would have fired by now if ungated.
    // A `waitFor` wrapping a `.not` assertion resolves on its first check and
    // would pass whether or not the effect ever ran.
    expect(getVisionModels).not.toHaveBeenCalled();
    expect(getAiAssignments).not.toHaveBeenCalled();
  });

  // /vision-models also returns `backend:'cli'` rows, and those are a blanket
  // per-PROVIDER claim: the server tags EVERY model of a `command:'claude'|'codex'`
  // CLI vision-capable because the CLI can read an image file. An ollama-backed
  // Claude CLI's model list is Ollama's TOOL-USE models, whose ids collide with
  // the real ollama provider's — so a flat id set would hand a text-only model to
  // the vision picker and sceneEvaluator would send frames to a model that can't
  // see them.
  it('ignores cli-backend rows so a text-only model cannot be smuggled in as vision', async () => {
    getVisionModels.mockResolvedValue({
      models: [
        { providerId: 'ollama', backend: 'ollama', id: 'gemma4:26b', vision: true },
        // The ollama-backed Claude CLI fronting a text-only Ollama model whose id
        // is also in the real `ollama` provider's list.
        { providerId: 'claude-ollama', backend: 'cli', id: 'llama3.2:latest', vision: true },
        // Vision on LM Studio only — must not make the same id vision on Ollama.
        { providerId: 'lmstudio', backend: 'lmstudio', id: 'qwen2.5vl:latest', vision: true },
      ],
    });
    renderDrawer({ id: 'cd-1', name: 'Demo', modelOverrides: {} });
    await waitFor(() => expect(getVisionModels).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Scene evaluation provider'), { target: { value: 'ollama' } });

    const optionValues = Array.from(
      screen.getByLabelText('Scene evaluation model').querySelectorAll('option'),
    ).map((o) => o.value);
    expect(optionValues).toContain('gemma4:26b');
    // The cli-backend row must NOT make this text-only id a vision option.
    expect(optionValues).not.toContain('llama3.2:latest');
  });

  it('falls back to the id regex when the vision-model fetch fails', async () => {
    getVisionModels.mockRejectedValue(new Error('ollama down'));
    renderDrawer({ id: 'cd-1', name: 'Demo', modelOverrides: {} });
    await waitFor(() => expect(screen.getByLabelText('Scene evaluation provider')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Scene evaluation provider'), { target: { value: 'ollama' } });

    const optionValues = Array.from(
      screen.getByLabelText('Scene evaluation model').querySelectorAll('option'),
    ).map((o) => o.value);
    expect(optionValues).toContain('qwen2.5vl:latest');
    expect(optionValues).not.toContain('llama3.2:latest');
  });

  // A cloud/custom API provider's list is never vision-filtered, so an empty one
  // means "no models configured", NOT "no VLM installed" — telling the user to
  // install a local VLM would be the wrong remediation.
  it('does not tell a cloud provider to install a local VLM', async () => {
    getAiAssignments.mockResolvedValue({
      ...ASSIGNMENTS,
      providers: [
        ...ASSIGNMENTS.providers,
        { id: 'my-cloud-vlm', name: 'My Cloud VLM', type: 'api', enabled: true, defaultModel: null, models: [] },
      ],
    });
    renderDrawer({ id: 'cd-1', name: 'Demo', modelOverrides: {} });
    await waitFor(() => expect(screen.getByLabelText('Scene evaluation provider')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Scene evaluation provider'), { target: { value: 'my-cloud-vlm' } });

    expect(screen.queryByText(/No vision-capable models found/i)).toBeNull();
    // The free-text fallback stays usable for a cloud provider with no list.
    expect(screen.getByLabelText('Scene evaluation model')).toBeTruthy();
  });

  it('warns instead of showing a bare text box when a vision provider has no VLM', async () => {
    getAiAssignments.mockResolvedValue({
      ...ASSIGNMENTS,
      providers: [
        ...ASSIGNMENTS.providers.filter((p) => p.id !== 'ollama'),
        // Text-only local backend — nothing survives the vision filter.
        { id: 'ollama', name: 'Ollama', type: 'api', enabled: true, defaultModel: 'llama3.2:latest', models: ['llama3.2:latest'] },
      ],
    });
    renderDrawer({ id: 'cd-1', name: 'Demo', modelOverrides: {} });
    await waitFor(() => expect(screen.getByLabelText('Scene evaluation provider')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Scene evaluation provider'), { target: { value: 'ollama' } });

    expect(screen.getByText(/No vision-capable models found/i)).toBeTruthy();
  });

  describe('global scope', () => {
    const renderGlobal = (props = {}) => render(
      <MemoryRouter>
        <CreativeDirectorModelsDrawer scope="global" open onClose={vi.fn()} {...props} />
      </MemoryRouter>,
    );

    it('seeds drafts from the CD-wide assignment defaults', async () => {
      getAiAssignments.mockResolvedValue({
        ...ASSIGNMENTS,
        assignments: ASSIGNMENTS.assignments.map((a) => (
          a.id === 'settings.creativeDirector.treatment'
            ? { ...a, providerId: 'agent-a', model: 'a-big' }
            : a
        )),
      });
      renderGlobal();
      await waitFor(() => expect(screen.getByLabelText('Treatment provider')).toBeTruthy());
      expect(screen.getByLabelText('Treatment provider').value).toBe('agent-a');
      expect(screen.getByLabelText('Treatment model').value).toBe('a-big');
      // Global scope pins the system default, so there is no "inherit" hint.
      expect(screen.queryByText(/Inherit:/)).toBeNull();
    });

    it('saves only the changed stage through the AI assignment endpoint', async () => {
      updateAiAssignment.mockResolvedValue(ASSIGNMENTS);
      renderGlobal();
      await waitFor(() => expect(screen.getByLabelText('Treatment provider')).toBeTruthy());

      fireEvent.change(screen.getByLabelText('Treatment provider'), { target: { value: 'agent-a' } });
      fireEvent.click(screen.getByRole('button', { name: /Save/i }));

      await waitFor(() => expect(updateAiAssignment).toHaveBeenCalledTimes(1));
      expect(updateAiAssignment.mock.calls[0][0]).toBe('settings.creativeDirector.treatment');
      expect(updateAiAssignment.mock.calls[0][1]).toEqual({ providerId: 'agent-a', model: 'a-default' });
      // Untouched stages are not PUT.
      expect(updateAiAssignment.mock.calls.map((c) => c[0])).not.toContain('settings.creativeDirector.plan');
    });

    it('does not write the project record', async () => {
      updateAiAssignment.mockResolvedValue(ASSIGNMENTS);
      renderGlobal();
      await waitFor(() => expect(screen.getByLabelText('Production plan provider')).toBeTruthy());
      fireEvent.change(screen.getByLabelText('Production plan provider'), { target: { value: 'agent-a' } });
      fireEvent.click(screen.getByRole('button', { name: /Save/i }));
      await waitFor(() => expect(updateAiAssignment).toHaveBeenCalled());
      expect(updateCreativeDirectorProject).not.toHaveBeenCalled();
    });
  });
});
