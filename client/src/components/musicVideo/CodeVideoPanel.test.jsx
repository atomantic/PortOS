import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getMusicVideoCodeDocument: vi.fn(),
  generateMusicVideoCode: vi.fn(),
  regenerateMusicVideoCodeSection: vi.fn(),
}));

vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [{ id: 'stub-provider', name: 'Stub Provider', models: ['fixture-model'] }],
    selectedProviderId: 'stub-provider',
    selectedModel: 'fixture-model',
    availableModels: ['fixture-model'],
    selectedProvider: { id: 'stub-provider', name: 'Stub Provider' },
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
  }),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import CodeVideoPanel from './CodeVideoPanel.jsx';

const DOC = {
  html: '<!doctype html><html><body><canvas id="c"></canvas></body></html>',
  durationSec: 2,
  fps: 24,
  width: 320,
  height: 180,
  song: { sections: [
    { id: 'a', label: 'Verse', startSec: 0, endSec: 1 },
    { id: 'b', label: 'Chorus', startSec: 1, endSec: 2 },
  ] },
};

const project = {
  id: 'mv-1',
  updatedAt: '2026-01-01T00:00:00.000Z',
  composition: {
    mode: 'code',
    codeVideo: {
      sections: [
        { id: 'a', source: 'export default () => {}' },
      ],
    },
  },
  productionReview: {
    approvals: {
      storyboard: {
        basis: 'approved-basis',
      },
    },
  },
};

const projectNoStoryboard = {
  id: 'mv-1',
  updatedAt: '2026-01-01T00:00:00.000Z',
  composition: { mode: 'code' },
  productionReview: {},
};

beforeEach(() => {
  api.getMusicVideoCodeDocument.mockReset();
  api.generateMusicVideoCode.mockReset();
  api.regenerateMusicVideoCodeSection.mockReset();
  api.getMusicVideoCodeDocument.mockResolvedValue(DOC);
  api.generateMusicVideoCode.mockResolvedValue({ project });
  api.regenerateMusicVideoCodeSection.mockResolvedValue({ project });
});

function renderPanel(testProject = project) {
  return render(
    <MemoryRouter initialEntries={['/music-video/mv-1']}>
      <CodeVideoPanel project={testProject} audioUrl={null} onProject={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('CodeVideoPanel (#9076)', () => {
  it('shows the provider before a click and does not generate on mount', async () => {
    renderPanel();
    expect(await screen.findByText(/Stub Provider \/ fixture-model/)).toBeTruthy();
    const generate = await screen.findByRole('button', { name: 'Generate code video' });
    await waitFor(() => expect(generate).toBeEnabled());
    expect(api.generateMusicVideoCode).not.toHaveBeenCalled();
    fireEvent.click(generate);
    await waitFor(() => expect(api.generateMusicVideoCode).toHaveBeenCalledWith(
      'mv-1',
      { providerId: 'stub-provider', model: 'fixture-model' },
      { silent: true },
    ));
  });

  it('steps a frame and selects the next section from the keyboard', async () => {
    renderPanel();
    await screen.findByLabelText('Scrub preview');
    fireEvent.keyDown(window, { key: '.' });
    expect(Number(screen.getByLabelText('Scrub preview').value)).toBeCloseTo(1 / 24, 5);
    fireEvent.keyDown(window, { key: ']' });
    const select = await screen.findByLabelText('Section to regenerate');
    await waitFor(() => expect(select.value).toBe('b'));
  });
});

describe('CodeVideoPanel section select (#10163)', () => {
  it('shows a section select with generated/default labels', async () => {
    renderPanel();
    const select = await screen.findByLabelText('Section to regenerate');
    expect(select).toBeTruthy();
    expect(select.querySelector('option[value="a"]').textContent).toContain('generated');
    expect(select.querySelector('option[value="b"]').textContent).toContain('default');
  });

  it('changes the ?section= param when a section is selected', async () => {
    renderPanel();
    const select = await screen.findByLabelText('Section to regenerate');
    fireEvent.change(select, { target: { value: 'b' } });
    await waitFor(() => {
      expect(select.value).toBe('b');
    });
  });

  it('disables both Generate buttons and shows reason when storyboard not approved', async () => {
    renderPanel(projectNoStoryboard);
    await screen.findByLabelText('Section to regenerate');
    const generateBtn = screen.getByRole('button', { name: /Generate code video/ });
    const regenerateBtn = screen.getByRole('button', { name: /Regenerate section/ });
    expect(generateBtn).toBeDisabled();
    expect(regenerateBtn).toBeDisabled();
    expect(await screen.findByText('Approve the storyboard first')).toBeTruthy();
  });

  it('enables Generate buttons when storyboard is approved', async () => {
    renderPanel();
    await screen.findByLabelText('Section to regenerate');
    const generateBtn = screen.getByRole('button', { name: /Generate code video/ });
    const regenerateBtn = screen.getByRole('button', { name: /Regenerate section/ });
    await waitFor(() => {
      expect(generateBtn).toBeEnabled();
      expect(regenerateBtn).toBeEnabled();
    });
    expect(screen.queryByText('Approve the storyboard first')).toBeFalsy();
  });
});
