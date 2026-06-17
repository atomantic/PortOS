import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EditorialFindingsTriage from './EditorialFindingsTriage';
import { findingManuscriptLink } from '../../../lib/editorialChecks';

const checksById = {
  'naming.dissimilar-names': { label: 'Character name dissimilarity', scope: 'series', kind: 'deterministic' },
};

const renderTriage = (props) => render(
  <MemoryRouter><EditorialFindingsTriage seriesId="ser-1" checksById={checksById} {...props} /></MemoryRouter>,
);

describe('EditorialFindingsTriage', () => {
  it('shows the empty state when there are no check-sourced findings', () => {
    renderTriage({ comments: [{ id: 'x', problem: 'no checkId', status: 'open' }] });
    expect(screen.getByText(/No editorial-check findings yet/i)).toBeTruthy();
  });

  it('groups findings by check with an open/total header and deep-links each finding', () => {
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', issueNumber: 5, problem: 'Confusable names: Alice / Adam' },
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'dismissed', severity: 'low', issueNumber: null, problem: 'Old finding' },
    ];
    renderTriage({ comments });
    expect(screen.getByText('Character name dissimilarity')).toBeTruthy();
    expect(screen.getByText(/1 open · 2 total/)).toBeTruthy();
    const link = screen.getByText('Confusable names: Alice / Adam').closest('a');
    expect(link.getAttribute('href')).toBe(findingManuscriptLink('ser-1', comments[0]));
  });
});
