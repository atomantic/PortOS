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

  it('renders a stale badge (group + per-finding) when an open finding is stale (#1345)', () => {
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Stale finding', stale: true },
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'open', severity: 'low', problem: 'Fresh finding' },
    ];
    renderTriage({ comments });
    // Group header badge ("1 stale") + per-finding badge ("Stale") = 2 badges.
    expect(screen.getByText('1 stale')).toBeTruthy();
    expect(screen.getByText('Stale')).toBeTruthy();
  });

  it('does NOT render a stale badge when no open finding is stale', () => {
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Fresh finding' },
      // A dismissed-but-stale finding must not surface a badge.
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'dismissed', severity: 'low', problem: 'Old', stale: true },
    ];
    renderTriage({ comments });
    expect(screen.queryByText('Stale')).toBeNull();
    expect(screen.queryByText(/stale/i)).toBeNull();
  });
});
