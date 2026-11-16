import { describe, it, expect, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import {
  api, renderPage, groupHeader, STAGES, SYSTEM_STAGES,
} from '../../test/promptManagerPageMocks.jsx';

const { getPrompts, getPrompt, getPromptUsage } = api;

const searchBox = () => screen.getByLabelText('Search prompt stages');

describe('StageCatalogue stage list', () => {
  beforeEach(() => {
    getPrompts.mockReset().mockResolvedValue({ stages: STAGES, systemStages: SYSTEM_STAGES });
    getPrompt.mockReset().mockResolvedValue({ name: 'Pipeline — Prose Draft', template: 'body', variables: [] });
    getPromptUsage.mockReset().mockResolvedValue({
      isSystemStage: false, usedBy: [], referencedBy: [], canDelete: true,
    });
  });

  it('shows collapsed groups and a stage count instead of a flat 100-row list', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    // Group headers, not rows.
    expect(groupHeader('Pipeline')).toBeTruthy();
    expect(groupHeader('Brain').getAttribute('aria-label')).toBe('Brain, 1 stage');
    expect(groupHeader('Pipeline').getAttribute('aria-label')).toBe('Pipeline, 2 stages');
    expect(screen.getByText('4 stages')).toBeTruthy();
    expect(screen.queryByText('Pipeline — Prose Draft')).toBeNull();
  });

  it('expands and re-collapses a group on click', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    const header = groupHeader('Pipeline');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Pipeline — Prose Draft')).toBeTruthy();

    fireEvent.click(header);
    expect(screen.queryByText('Pipeline — Prose Draft')).toBeNull();
  });

  it('filters rows on the title as the user types, auto-revealing matches', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'comic' } });

    // No manual expand needed — a filtered group shows its matches.
    expect(screen.getByText('Pipeline — Comic Book Script')).toBeTruthy();
    expect(screen.queryByText('Pipeline — Prose Draft')).toBeNull();
    expect(screen.queryByText('Brain Classifier')).toBeNull();
    expect(screen.getByText('1 of 4')).toBeTruthy();
  });

  it('keeps the group toggle live while filtering so a broad query can be folded', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    // A query matching everything must not become an uncollapsible wall.
    fireEvent.change(searchBox(), { target: { value: 'e' } });
    expect(screen.getByText('4 of 4')).toBeTruthy();
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Pipeline — Prose Draft')).toBeTruthy();

    fireEvent.click(groupHeader('Pipeline'));
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Pipeline — Prose Draft')).toBeNull();
    // Folding one group leaves the others open.
    expect(screen.getByText('Brain Classifier')).toBeTruthy();
  });

  it('forgets a filter-scoped collapse once the filter clears', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'e' } });
    fireEvent.click(groupHeader('Pipeline'));
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('false');

    // Clearing returns to the collapsed-by-default view...
    fireEvent.change(searchBox(), { target: { value: '' } });
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('false');
    // ...and the stale fold does not carry into the NEXT filter session. This
    // is the assertion that actually observes the set — while no filter is on,
    // `collapsedWhileFiltering` is never read, so clearing it is invisible.
    fireEvent.change(searchBox(), { target: { value: 'e' } });
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('true');
  });

  it('drops a fold when the query is refined, so the new match cannot hide behind it', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'e' } });
    fireEvent.click(groupHeader('Pipeline'));
    expect(screen.queryByText('Pipeline — Comic Book Script')).toBeNull();

    // Refining to a query whose ONLY hit lives in the folded group must show it.
    fireEvent.change(searchBox(), { target: { value: 'comic' } });
    expect(screen.getByText('1 of 4')).toBeTruthy();
    expect(screen.getByText('Pipeline — Comic Book Script')).toBeTruthy();
  });

  it('drops a fold when the SYSTEM toggle changes the filter', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'e' } });
    fireEvent.click(groupHeader('Brain'));
    expect(screen.queryByText('Brain Classifier')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /system only/i }));
    expect(screen.getByText('Brain Classifier')).toBeTruthy();
  });

  it('folds two spellings of the same family into one group', async () => {
    getPrompts.mockResolvedValue({
      stages: {
        ...STAGES,
        'pipeline-lowercase': { name: 'pipeline — hand typed', description: 'user made' },
      },
      systemStages: SYSTEM_STAGES,
    });
    await renderPage();
    await screen.findByText('Prompt Stages');

    // One PIPELINE header, holding all three — not two headers that render alike.
    expect(screen.getAllByRole('button', { name: /^Pipeline, \d+ stages?$/i })).toHaveLength(1);
    fireEvent.click(groupHeader('Pipeline'));
    expect(screen.getByText('pipeline — hand typed')).toBeTruthy();
    expect(screen.getByText('Pipeline — Prose Draft')).toBeTruthy();
  });

  it('filters on the description too', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'balloons' } });
    expect(screen.getByText('Pipeline — Comic Book Script')).toBeTruthy();
    expect(screen.getByText('1 of 4')).toBeTruthy();
  });

  it('reports an empty result rather than a silently blank pane', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'zzzz' } });
    expect(screen.getByText('No stages match that search')).toBeTruthy();
  });

  it('clears the query from the clear button', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'comic' } });
    fireEvent.click(screen.getByLabelText('Clear stage search'));

    expect(searchBox().value).toBe('');
    expect(screen.getByText('4 stages')).toBeTruthy();
    // Rows the filter revealed go back into their collapsed groups.
    expect(screen.queryByText('Pipeline — Comic Book Script')).toBeNull();
  });

  it('narrows to system stages with the SYSTEM-only toggle', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    const toggle = screen.getByRole('button', { name: /system only/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Brain Classifier')).toBeTruthy();
    expect(screen.queryByText('Pipeline — Prose Draft')).toBeNull();
    expect(screen.getByText('1 of 4')).toBeTruthy();
  });

  // The badge and the filter follow the SERVED list, not a client-side copy of
  // it (#3314) — a stage the server names is reachable even though no hardcoded
  // client array ever mentioned it.
  it('badges and filters whatever the server names in systemStages', async () => {
    getPrompts.mockResolvedValue({ stages: STAGES, systemStages: ['creative-director-treatment'] });
    await renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.click(screen.getByRole('button', { name: /system only/i }));
    expect(screen.getByText('Creative Director — Treatment')).toBeTruthy();
    expect(screen.queryByText('Brain Classifier')).toBeNull();
    expect(screen.getByText('1 of 4')).toBeTruthy();
    // The Settings header's "System" group label is not a stage badge.
    expect(screen.getAllByText('System').filter((el) => !el.closest('nav'))).toHaveLength(1);
  });

  // An older server (or a failed load) sends no list: badge nothing, filter to
  // nothing — never crash on a missing key.
  it('degrades to no system stages when the server omits the list', async () => {
    getPrompts.mockResolvedValue({ stages: STAGES });
    await renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.click(screen.getByRole('button', { name: /system only/i }));
    expect(screen.getByText('No stages match that search')).toBeTruthy();
    expect(screen.getByText('0 of 4')).toBeTruthy();
  });

  it('selects a stage into the URL from a filtered row', async () => {
    await renderPage();
    await screen.findByText('Prompt Stages');

    fireEvent.change(searchBox(), { target: { value: 'comic' } });
    fireEvent.click(screen.getByText('Pipeline — Comic Book Script'));

    await waitFor(() => expect(getPrompt).toHaveBeenCalledWith('pipeline-comic-script', { silent: true }));
  });

  it('opens the group holding a deep-linked stage', async () => {
    await renderPage('/prompts/stages?stage=brain-classifier');
    await screen.findByText('Prompt Stages');

    await waitFor(() => expect(groupHeader('Brain').getAttribute('aria-expanded')).toBe('true'));
    expect(screen.getByText('Brain Classifier')).toBeTruthy();
    // Sibling groups stay closed.
    expect(groupHeader('Pipeline').getAttribute('aria-expanded')).toBe('false');
  });
});
