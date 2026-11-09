import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../../hooks/useLocalImageModels.js', () => ({
  default: () => ({ models: [{ id: 'example-local', name: 'Example Local' }], installDefault: 'example-local', failed: false }),
}));
vi.mock('../../hooks/useRunwayCatalog.js', () => ({
  useRunwayCatalog: () => ({ imageModels: [{ id: 'gen4_image', label: 'Gen-4 Image' }] }),
}));

import SceneFrameRenderTarget, {
  frameRenderTargetOverrides, lastFrameRenderTarget, rememberFrameRenderTarget,
} from './SceneFrameRenderTarget.jsx';
import { FAL_IMAGE_MODEL_OPTIONS } from '../../lib/imageGenBackends';

beforeEach(() => localStorage.clear());

describe('frame render target', () => {
  // Uniquely catches a project-setting render sending a mode, a local id going out as cloudModel, or a grok model the route rejects.
  it('maps a named backend onto that backend\'s request fields and leaves the project pin alone', () => {
    expect(frameRenderTargetOverrides('')).toBeNull();
    expect(frameRenderTargetOverrides('nope')).toBeNull();
    expect(frameRenderTargetOverrides('local', {})).toEqual({ mode: 'local' });
    expect(frameRenderTargetOverrides('local', { modelId: ' example-local ' })).toEqual({ mode: 'local', modelId: 'example-local' });
    expect(frameRenderTargetOverrides('local', { modelId: 'example-local' }).cloudModel).toBeUndefined();
    expect(frameRenderTargetOverrides('codex', { modelId: 'gpt-example' })).toEqual({ mode: 'codex', cloudModel: 'gpt-example' });
    expect(frameRenderTargetOverrides('codex', { modelId: 'gpt-example' }).modelId).toBeUndefined();
    expect(frameRenderTargetOverrides('codex', { modelId: '  ' })).toEqual({ mode: 'codex' });
    expect(frameRenderTargetOverrides('fal', { modelId: 'fal-ai/example' })).toEqual({ mode: 'fal', cloudModel: 'fal-ai/example' });
    expect(frameRenderTargetOverrides('runway', { modelId: 'gen4_image' })).toEqual({ mode: 'runway', cloudModel: 'gen4_image' });
    expect(frameRenderTargetOverrides('grok', { modelId: 'ignored' })).toEqual({ mode: 'grok' });
  });

  // Uniquely catches the clip tab's remembered pick becoming the next frame's service.
  it('remembers a frame pick on its own key and drops a model the backend cannot take', () => {
    rememberFrameRenderTarget('codex', { modelId: 'gpt-example' });
    expect(lastFrameRenderTarget()).toEqual({ pick: 'codex', options: { modelId: 'gpt-example' } });
    rememberFrameRenderTarget('grok', { modelId: 'ignored' });
    expect(lastFrameRenderTarget()).toEqual({ pick: 'grok', options: {} });
    rememberFrameRenderTarget('local', {});
    expect(lastFrameRenderTarget()).toEqual({ pick: 'local', options: {} });
    localStorage.setItem('portos.musicVideo.lastRenderOn', JSON.stringify({ pick: 'grok', modelId: 'ltx' }));
    expect(lastFrameRenderTarget()).toEqual({ pick: 'local', options: {} });
    rememberFrameRenderTarget('not-a-service', { modelId: 'leftover' });
    expect(lastFrameRenderTarget()).toEqual({ pick: '', options: {} });
  });
});

describe('frame Render on control', () => {
  function Harness({ project = { imageMode: 'grok', imageModelId: 'example-model' } }) {
    const [value, setValue] = useState('');
    const [options, setOptions] = useState({});
    return (
      <SceneFrameRenderTarget id="frame" value={value} options={options} project={project}
        onChange={setValue} onOptionsChange={setOptions} />
    );
  }

  // Uniquely catches a model control for a backend that has none, a typed id waiting on blur, or a model surviving a backend change.
  it('shows a model only where the backend takes one, commits it immediately, and clears it when the backend changes', () => {
    render(<Harness />);
    const pick = screen.getByLabelText('Render on');
    expect(pick.textContent).toContain('Project setting · Grok · example-model');
    expect(screen.queryByLabelText('Model')).toBeNull();

    fireEvent.change(pick, { target: { value: 'grok' } });
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(lastFrameRenderTarget()).toEqual({ pick: 'grok', options: {} });

    fireEvent.change(screen.getByLabelText('Render on'), { target: { value: 'local' } });
    const local = screen.getByLabelText('Model');
    expect(within(local).getByRole('option', { name: 'Example Local' })).toBeTruthy();
    fireEvent.change(local, { target: { value: 'example-local' } });
    expect(frameRenderTargetOverrides('local', lastFrameRenderTarget().options)).toEqual({ mode: 'local', modelId: 'example-local' });

    fireEvent.change(screen.getByLabelText('Render on'), { target: { value: 'codex' } });
    expect(lastFrameRenderTarget().options).toEqual({});
    const typed = screen.getByLabelText('Model');
    expect(typed.value).toBe('');
    fireEvent.change(typed, { target: { value: 'gpt-example' } });
    expect(typed.value).toBe('gpt-example');
    expect(frameRenderTargetOverrides('codex', lastFrameRenderTarget().options)).toEqual({ mode: 'codex', cloudModel: 'gpt-example' });

    fireEvent.change(screen.getByLabelText('Render on'), { target: { value: 'fal' } });
    const fal = screen.getByLabelText('Model');
    const falOption = within(fal).getAllByRole('option').find((option) => option.value === FAL_IMAGE_MODEL_OPTIONS[0].id);
    expect(falOption).toBeTruthy();
    fireEvent.change(fal, { target: { value: falOption.value } });
    expect(frameRenderTargetOverrides('fal', lastFrameRenderTarget().options).cloudModel).toBe(FAL_IMAGE_MODEL_OPTIONS[0].id);

    fireEvent.change(screen.getByLabelText('Render on'), { target: { value: 'runway' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gen4_image' } });
    expect(frameRenderTargetOverrides('runway', lastFrameRenderTarget().options)).toEqual({ mode: 'runway', cloudModel: 'gen4_image' });
  });
});
