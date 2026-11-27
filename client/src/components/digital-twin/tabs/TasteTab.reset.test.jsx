import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as renderView, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const render = (ui) => renderView(ui, { wrapper: MemoryRouter });

vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getTasteProfile: vi.fn(),
  getTasteNextQuestion: vi.fn(),
  getTasteSectionResponses: vi.fn(),
  resetTasteSection: vi.fn(),
}));
vi.mock('../../../services/apiProviders.js', () => ({ getProviders: vi.fn() }));
vi.mock('../../../services/socket', () => ({ default: { connected: false, on: vi.fn(), off: vi.fn() } }));
vi.mock('../../ui/Toast');
vi.mock('../ObservedTasteEvidence', () => ({ default: () => null }));
vi.mock('../../cos/MarkdownOutput', () => ({ default: ({ content }) => <div>{content}</div> }));
vi.mock('../TwinProviderPicker.jsx', () => ({ default: () => null }));

import TasteTab from './TasteTab';
import { getTasteProfile, getTasteNextQuestion, getTasteSectionResponses, resetTasteSection } from '../../../services/apiDigitalTwin.js';
import { getProviders } from '../../../services/apiProviders.js';

const PROFILE = {
  completedCount: 0,
  totalSections: 1,
  sections: [{ id: 'movies', label: 'Movies', description: 'Films', status: 'in_progress', progress: { coreAnswered: 1, coreTotal: 3, percentage: 33 } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  getTasteProfile.mockResolvedValue(PROFILE);
  getTasteNextQuestion.mockResolvedValue(null);
  getProviders.mockResolvedValue({ providers: [] });
  getTasteSectionResponses.mockResolvedValue([{ questionText: 'Favorite film?', answer: 'Example Film' }]);
});

describe('TasteTab Reset Section confirmation', () => {
  it('requires an explicit confirm before the DELETE, and Cancel resets nothing', async () => {
    const user = userEvent.setup();
    render(<TasteTab />);
    await user.click(await screen.findByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: /Reset Section/ }));

    expect(resetTasteSection).not.toHaveBeenCalled();
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/This cannot be undone/)).not.toBeInTheDocument();
    expect(resetTasteSection).not.toHaveBeenCalled();
  });

  it('sends one DELETE while in flight even if confirm is clicked twice', async () => {
    let release;
    resetTasteSection.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    render(<TasteTab />);
    await user.click(await screen.findByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: /Reset Section/ }));
    const confirm = screen.getAllByRole('button', { name: 'Reset Section' }).at(-1);
    await user.click(confirm);
    await user.click(confirm);
    expect(resetTasteSection).toHaveBeenCalledTimes(1);
    expect(resetTasteSection).toHaveBeenCalledWith('movies');
    release({});
    await waitFor(() => expect(screen.queryByText(/This cannot be undone/)).not.toBeInTheDocument());
  });
});
