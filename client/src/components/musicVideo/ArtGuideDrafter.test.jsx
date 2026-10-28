import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ProductionReviewPanel from './ProductionReviewPanel.jsx';

const { proposeMusicVideoArtGuides } = vi.hoisted(() => ({ proposeMusicVideoArtGuides: vi.fn() }));
vi.mock('../../services/apiMusicVideo.js', async (importOriginal) => ({ ...await importOriginal(), proposeMusicVideoArtGuides }));
vi.mock('../../hooks/useProviderModels.js', () => ({ default: () => ({ providers: [{ id: 'llm' }], selectedProviderId: 'llm', selectedModel: 'model-a', availableModels: ['model-a'], setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }) }));
vi.mock('../ProviderModelSelector.jsx', () => ({ default: () => null }));

const draft = { cast: '', environments: 'Old stage', visualLanguage: '', motionLanguage: '', storyboard: [] };
const project = (storySummary) => ({ id: 'example-project', scenes: [], lyricCues: [], storySummary, productionReview: { draft } });
const review = () => ({ readiness: null, busy: false, proof: { active: false }, approve: vi.fn(), save: vi.fn(async () => true) });

describe('Drafting the art guides from the story', () => {
  it('asks for the story first', () => {
    render(<ProductionReviewPanel project={project('')} review={review()} onOpenArtifact={vi.fn()} stage="art" />);
    expect(screen.getByRole('button', { name: 'Draft guides from my story' })).toBeDisabled();
  });

  it('shows the prompt additions, fills only the guide the director uses, and saves only on Save planning edits', async () => {
    proposeMusicVideoArtGuides.mockResolvedValue({ proposal: { cast: 'June at 8, 17 and 40', environments: 'A lake house' },
      sentPrompt: 'Story in your own words:\nJune grows up', promptAdditions: [{ id: 'story', label: 'Story in your own words', text: 'June grows up' }] });
    const r = review();
    render(<ProductionReviewPanel project={project('June grows up')} review={r} onOpenArtifact={vi.fn()} stage="art" />);
    fireEvent.click(screen.getByRole('button', { name: 'Draft guides from my story' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Draft guides' })); });
    expect(proposeMusicVideoArtGuides).toHaveBeenCalledWith('example-project', { providerId: 'llm', model: 'model-a', effort: undefined, executionOptions: {}, preview: false }, { silent: true });
    expect(screen.getByRole('button', { name: '+ Story in your own words' })).toBeInTheDocument();
    expect(screen.getByLabelText('Environment guide').value).toBe('Old stage');

    fireEvent.click(screen.getAllByRole('button', { name: 'Use' })[0]);
    expect(screen.getByLabelText('Cast guide').value).toBe('June at 8, 17 and 40');
    expect(screen.getByLabelText('Environment guide').value).toBe('Old stage');
    expect(r.save).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save planning edits' })); });
    expect(r.save).toHaveBeenCalledWith(expect.objectContaining({ cast: 'June at 8, 17 and 40', environments: 'Old stage' }));
  });
});
