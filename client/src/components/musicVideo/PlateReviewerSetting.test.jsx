import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ updateMusicVideoProject: vi.fn() }));
vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../services/api', async (original) => ({
  ...(await original()),
  getProviders: vi.fn(async () => ({ activeProvider: '', providers: [
    { id: 'example-api', name: 'Example API', type: 'api', enabled: true, models: ['vision-a', 'vision-b'], defaultModel: 'vision-a' },
    { id: 'example-tui', name: 'Example TUI', type: 'tui', enabled: true, models: ['m'] },
  ] })),
}));

const { default: PlateReviewerSetting } = await import('./PlateReviewerSetting.jsx');

beforeEach(() => api.updateMusicVideoProject.mockReset().mockImplementation(async (id, patch) => ({ id, ...patch })));

describe('frame check reviewer', () => {
  // Uniquely catches the project's reviewer pick not saving, or the default not clearing it.
  it('saves a picked provider on its default model and clears back to the default', async () => {
    const onProjectUpdated = vi.fn();
    render(<PlateReviewerSetting project={{ id: 'mv-example', plateReviewer: null }} onProjectUpdated={onProjectUpdated} />);
    const select = await screen.findByLabelText('Frame check');
    await waitFor(() => expect(screen.getByRole('option', { name: /Example API/ })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /Example TUI/ })).toBeNull();
    fireEvent.change(select, { target: { value: 'example-api' } });
    await waitFor(() => expect(api.updateMusicVideoProject).toHaveBeenCalledWith('mv-example', { plateReviewer: { providerId: 'example-api', model: null } }, expect.anything()));
    await waitFor(() => expect(onProjectUpdated).toHaveBeenCalled());
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(api.updateMusicVideoProject).toHaveBeenLastCalledWith('mv-example', { plateReviewer: null }, expect.anything()));
  });
});
