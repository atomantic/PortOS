import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import ManuscriptIssueTabs from './ManuscriptIssueTabs';

const SECTIONS = [
  { issueId: 'i1', number: 1, title: 'First', stageId: 'prose', content: 'a' },
  { issueId: 'i2', number: 2, title: '', stageId: 'prose', content: 'b' },
];

const renderTabs = (props = {}) => render(
  <MemoryRouter>
    <ManuscriptIssueTabs
      seriesId="s1"
      sections={SECTIONS}
      activeNumber={1}
      openCountByNumber={new Map()}
      {...props}
    />
  </MemoryRouter>,
);

describe('ManuscriptIssueTabs', () => {
  it('renders one deep-linkable tab per issue', () => {
    renderTabs();
    expect(screen.getByTitle('Issue 1 — First')).toHaveAttribute('href', '/pipeline/series/s1/manuscript/1');
    expect(screen.getByTitle('Issue 2')).toHaveAttribute('href', '/pipeline/series/s1/manuscript/2');
  });

  it('badges the count of open notes anchored in that issue', () => {
    renderTabs({ openCountByNumber: new Map([[2, 3]]) });
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('marks only the issues holding an unsaved edit (#3399)', () => {
    renderTabs({ dirtyNumbers: new Set([2]) });
    expect(screen.getByLabelText('Issue 2 has unsaved edits')).toBeInTheDocument();
    expect(screen.queryByLabelText('Issue 1 has unsaved edits')).not.toBeInTheDocument();
    // The tooltip says so too, for the pointer path.
    expect(screen.getByTitle('Issue 2 (unsaved edits)')).toBeInTheDocument();
  });

  it('renders no dirty dot when no issue has pending edits', () => {
    renderTabs({ dirtyNumbers: new Set() });
    expect(screen.queryByLabelText(/unsaved edits/)).not.toBeInTheDocument();
  });

  it('tolerates an absent dirtyNumbers prop', () => {
    renderTabs();
    expect(screen.queryByLabelText(/unsaved edits/)).not.toBeInTheDocument();
  });

  it('renders nothing when the series has no drafted sections', () => {
    const { container } = renderTabs({ sections: [] });
    expect(container).toBeEmptyDOMElement();
  });
});
