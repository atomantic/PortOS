import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getAutobiographyStats: vi.fn(),
  getAutobiographyStories: vi.fn(),
  getAutobiographyThemes: vi.fn(),
  getAutobiographyConfig: vi.fn(),
  getAutobiographySuggestions: vi.fn(),
  getAutobiographyPromptById: vi.fn(),
  getAutobiographyPrompt: vi.fn(),
  saveAutobiographyStory: vi.fn(),
  deleteAutobiographyStory: vi.fn(),
}));
vi.mock('../../ui/Toast');
vi.mock('../StoryCraftPanel', () => ({ default: () => null }));

import AutobiographyTab from './AutobiographyTab';
import {
  getAutobiographyStats,
  getAutobiographyConfig,
  getAutobiographyStories,
  getAutobiographyThemes,
  getAutobiographySuggestions,
} from '../../../services/apiDigitalTwin.js';

const STORY = {
  id: 'story-1', themeId: 'childhood', themeLabel: 'Childhood', promptText: 'A question?',
  content: 'Once upon a time', wordCount: 4, createdAt: '2026-01-01T00:00:00.000Z',
};
const THEME = { id: 'childhood', label: 'Childhood' };

const renderTab = () => render(<MemoryRouter><AutobiographyTab onRefresh={vi.fn()} /></MemoryRouter>);

describe('AutobiographyTab failed loads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAutobiographyStats.mockResolvedValue({ totalStories: 1, totalWords: 4, byTheme: {} });
    getAutobiographyConfig.mockResolvedValue(null);
    getAutobiographyStories.mockResolvedValue([STORY]);
    getAutobiographyThemes.mockResolvedValue([THEME]);
    getAutobiographySuggestions.mockResolvedValue([]);
  });

  it('shows a retryable error instead of "No stories yet" when the story read fails', async () => {
    getAutobiographyStories.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load stories');
    expect(screen.queryByText('No stories yet')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText("A question?")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps "No stories yet" for a genuinely empty journal', async () => {
    getAutobiographyStories.mockResolvedValue([]);
    renderTab();
    expect(await screen.findByText('No stories yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a retryable error row when the themes read fails', async () => {
    getAutobiographyThemes.mockRejectedValueOnce(new Error('boom'));
    renderTab();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load story themes');
    expect(await screen.findByText("A question?")).toBeInTheDocument();
  });

  it('shows a retryable error row when the story ideas read fails', async () => {
    getAutobiographySuggestions.mockRejectedValueOnce(new Error('boom'));
    renderTab();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load story ideas');
  });
});
