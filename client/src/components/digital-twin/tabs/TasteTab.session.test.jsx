import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getTasteProfile: vi.fn(),
  getTasteNextQuestion: vi.fn(),
  getPersonalizedTasteQuestion: vi.fn(),
  submitTasteAnswer: vi.fn(),
  getTasteSectionResponses: vi.fn(),
  generateTasteSummary: vi.fn(),
}));
vi.mock('../../../services/apiProviders.js', () => ({ getProviders: vi.fn() }));
vi.mock('../../../services/socket', () => ({ default: { connected: false, on: vi.fn(), off: vi.fn() } }));
vi.mock('../../ui/Toast');
vi.mock('../ObservedTasteEvidence', () => ({ default: () => null }));
vi.mock('../../cos/MarkdownOutput', () => ({ default: ({ content }) => <div>{content}</div> }));
vi.mock('../TwinProviderPicker.jsx', () => ({ default: () => null }));

import {
  generateTasteSummary,
  getPersonalizedTasteQuestion,
  getTasteNextQuestion,
  getTasteProfile,
  getTasteSectionResponses,
  submitTasteAnswer,
} from '../../../services/apiDigitalTwin.js';
import { getProviders } from '../../../services/apiProviders.js';
import toast from '../../ui/Toast';
import TasteTab from './TasteTab';

const PROVIDER = { id: 'test-api', type: 'api', enabled: true, defaultModel: 'test-model' };
const MOVIE = { questionId: 'movie-question', text: 'Favorite film?', isFollowUp: true };
const MUSIC = { questionId: 'music-question', text: 'Favorite album?' };

beforeEach(() => {
  vi.resetAllMocks();
  getTasteProfile.mockResolvedValue({
    completedCount: 1,
    totalSections: 2,
    sections: [
      { id: 'movies', label: 'Movies', progress: { coreAnswered: 1 }, summary: 'Example summary' },
      { id: 'music', label: 'Music' },
    ],
  });
  getProviders.mockResolvedValue({ providers: [PROVIDER] });
  getTasteNextQuestion.mockResolvedValue(null);
  getTasteSectionResponses.mockResolvedValue([{ questionText: MOVIE.text, answer: 'Example film' }]);
  submitTasteAnswer.mockResolvedValue({ nextQuestion: null });
});

async function openMovies(user) {
  await user.click(await screen.findByRole('button', { name: /Movies/ }));
}

async function switchToMusic(user) {
  await user.click(screen.getByRole('button', { name: 'Back to sections' }));
  await user.click(screen.getByRole('button', { name: /Music/ }));
  await screen.findByRole('heading', { name: MUSIC.text });
}

describe('TasteTab session transitions', () => {
  it.each(['resolve', 'reject'])('ignores a late first question when the earlier request ends in %s', async (outcome) => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers();
    getTasteNextQuestion.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(MUSIC);
    render(<TasteTab />);

    await openMovies(user);
    await switchToMusic(user);
    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), 'Example album');
    await act(async () => {
      if (outcome === 'resolve') pending.resolve(MOVIE);
      else pending.reject(new Error('old request failed'));
    });

    expect(screen.queryByRole('heading', { name: MOVIE.text })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(submitTasteAnswer).toHaveBeenCalledWith('music', MUSIC.questionId, 'Example album', {}, { silent: true });
  });

  it('reports a Skip failure and preserves the question and draft for retry', async () => {
    const user = userEvent.setup();
    getTasteNextQuestion.mockResolvedValueOnce(MOVIE).mockRejectedValueOnce(new Error('network unavailable'));
    render(<TasteTab />);

    await openMovies(user);
    const draft = await screen.findByRole('textbox', { name: 'Your answer' });
    await user.type(draft, 'My draft');
    await user.click(screen.getByRole('button', { name: 'Skip' }));

    expect(toast.error).toHaveBeenCalledWith('Failed to skip question: network unavailable');
    expect(screen.getByRole('heading', { name: MOVIE.text })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveValue('My draft');
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
  });

  it('discards a late Skip result after switching sections', async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers();
    getTasteNextQuestion.mockResolvedValueOnce(MOVIE).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(MUSIC);
    render(<TasteTab />);

    await openMovies(user);
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    await switchToMusic(user);
    await act(async () => pending.resolve(null));

    expect(screen.getByRole('heading', { name: MUSIC.text })).toBeInTheDocument();
  });

  it('discards a late personalized question after switching sections', async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers();
    getTasteNextQuestion.mockResolvedValueOnce(null).mockResolvedValueOnce(MUSIC);
    getPersonalizedTasteQuestion.mockReturnValueOnce(pending.promise);
    render(<TasteTab />);

    await openMovies(user);
    await user.click(await screen.findByRole('button', { name: 'Go Deeper' }));
    await switchToMusic(user);
    await act(async () => pending.resolve({ question: { ...MOVIE, isPersonalized: true } }));

    expect(screen.getByRole('heading', { name: MUSIC.text })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: MOVIE.text })).not.toBeInTheDocument();
  });

  it('drops the next question from a save that completes in another section', async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers();
    submitTasteAnswer.mockReturnValueOnce(pending.promise);
    getTasteNextQuestion.mockResolvedValueOnce(MOVIE).mockResolvedValueOnce(MUSIC);
    render(<TasteTab />);

    await openMovies(user);
    await user.type(await screen.findByRole('textbox', { name: 'Your answer' }), 'Example film');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await switchToMusic(user);
    await act(async () => pending.resolve({ nextQuestion: { ...MOVIE, text: 'Another film?' } }));

    expect(screen.getByRole('heading', { name: MUSIC.text })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Another film?' })).not.toBeInTheDocument();
  });

  it('announces summary expansion and gates review summary generation on an API provider', async () => {
    const user = userEvent.setup();
    getProviders.mockResolvedValue({ providers: [] });
    render(<TasteTab />);

    const summary = await screen.findByRole('button', { name: 'Summary' });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    await user.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Review' }));
    const generate = await screen.findByRole('button', { name: 'Regenerate Summary' });
    expect(generate).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Open AI Providers' })).toHaveAttribute('href', '/ai');
    await user.click(generate);
    expect(generateTasteSummary).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Reset Section' }));
    await user.click(screen.getByRole('button', { name: 'Back to sections' }));
    expect(screen.getByRole('button', { name: 'Summary' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByText('Example film');
    expect(screen.queryByText(/This cannot be undone/)).not.toBeInTheDocument();
  });
});
