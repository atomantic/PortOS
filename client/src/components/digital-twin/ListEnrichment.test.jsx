import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getEnrichmentListItems: vi.fn(),
  analyzeEnrichmentList: vi.fn(),
  saveEnrichmentList: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import * as api from '../../services/api';
import ListEnrichment from './ListEnrichment';

const ANALYSIS = {
  itemAnalysis: [{ title: 'Example Book', insights: 'Example insight' }],
  patterns: ['Example pattern'],
  personalityInsights: { exampleTrait: 'Example value' },
  targetDoc: 'example-doc',
  suggestedDocument: 'Example document body',
};

const renderAnalyzed = async () => {
  api.getEnrichmentListItems.mockResolvedValue([{ title: 'Example Book', note: '' }]);
  api.analyzeEnrichmentList.mockResolvedValue(ANALYSIS);
  render(
    <ListEnrichment
      categoryId="favorite_books"
      onBack={() => {}}
      onRefresh={() => {}}
      providers={[{ id: 'example', name: 'Example', models: ['example-model'] }]}
      selectedProvider={{ providerId: 'example', model: 'example-model' }}
      setSelectedProvider={() => {}}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: /Analyze & Generate/i }));
  await screen.findByRole('button', { name: /Patterns Detected/i });
};

describe('ListEnrichment saved list read', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a failed read as a retryable error instead of a blank list a save would replace', async () => {
    api.getEnrichmentListItems.mockRejectedValueOnce(new Error('boom'));
    api.getEnrichmentListItems.mockResolvedValue([{ title: 'Example Book', note: '' }]);
    render(
      <ListEnrichment
        categoryId="favorite_books"
        onBack={() => {}}
        onRefresh={() => {}}
        providers={[]}
        selectedProvider={null}
        setSelectedProvider={() => {}}
      />
    );

    expect(await screen.findByText(/Could not load your saved list/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Analyze & Generate/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByDisplayValue('Example Book')).toBeInTheDocument();
    expect(api.getEnrichmentListItems).toHaveBeenCalledWith('favorite_books', { silent: true });
  });
});

describe('ListEnrichment analysis disclosures', () => {
  beforeEach(() => vi.clearAllMocks());

  // Each collapsible header must announce its state (#3922) — the chevron icon
  // alone leaves screen-reader users with no expanded/collapsed feedback.
  it.each([
    ['Item-by-Item Analysis', 'item-analysis-panel', false],
    ['Patterns Detected', 'patterns-panel', true],
    ['Personality Insights', 'insights-panel', true],
  ])('exposes %s as a disclosure wired to its panel', async (label, panelId, defaultOpen) => {
    await renderAnalyzed();
    const button = screen.getByRole('button', { name: new RegExp(label, 'i') });
    expect(button).toHaveAttribute('aria-expanded', String(defaultOpen));
    expect(button).toHaveAttribute('aria-controls', panelId);
    if (defaultOpen) expect(document.getElementById(panelId)).toBeTruthy();
  });

  it('flips aria-expanded when a section is toggled', async () => {
    await renderAnalyzed();
    const button = screen.getByRole('button', { name: /Item-by-Item Analysis/i });
    expect(document.getElementById('item-analysis-panel')).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'true'));
    expect(document.getElementById('item-analysis-panel')).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
    expect(document.getElementById('item-analysis-panel')).toBeNull();
  });
});

describe('ListEnrichment stored-list load', () => {
  beforeEach(() => vi.clearAllMocks());

  const renderEditor = () => render(
    <ListEnrichment
      categoryId="favorite_books"
      onBack={() => {}}
      onRefresh={() => {}}
      providers={[{ id: 'example', name: 'Example', models: ['example-model'] }]}
      selectedProvider={{ providerId: 'example', model: 'example-model' }}
      setSelectedProvider={() => {}}
    />
  );

  // Saving replaces the stored list, so an editor seeded from a failed read
  // would let the next save overwrite real data with a blank list.
  it('shows an error with Retry instead of a blank editor when the stored list fails to load', async () => {
    api.getEnrichmentListItems
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([{ title: 'Example Book', note: '' }]);
    renderEditor();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load .*offline/i);
    expect(screen.queryByRole('button', { name: /Analyze & Generate/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByDisplayValue('Example Book')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.saveEnrichmentList).not.toHaveBeenCalled();
  });

  it('opens a blank editor only when the stored list is genuinely empty', async () => {
    api.getEnrichmentListItems.mockResolvedValue([]);
    renderEditor();
    expect(await screen.findByRole('button', { name: /Analyze & Generate/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('textbox').length).toBeGreaterThan(0);
  });

  it('surfaces a failed provider list beside the picker instead of an empty picker', async () => {
    api.getEnrichmentListItems.mockResolvedValue([]);
    const onRetryProviders = vi.fn();
    render(
      <ListEnrichment
        categoryId="favorite_books"
        onBack={() => {}}
        providers={[]}
        providersError={new Error('providers down')}
        onRetryProviders={onRetryProviders}
        selectedProvider={null}
        setSelectedProvider={() => {}}
      />
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load AI providers/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryProviders).toHaveBeenCalledTimes(1);
  });
});
