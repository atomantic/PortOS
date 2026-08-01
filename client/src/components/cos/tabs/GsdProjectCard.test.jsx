import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../services/api', () => ({
  getGsdProject: vi.fn().mockResolvedValue({ phases: [] }),
}));

import GsdProjectCard from './GsdProjectCard';

const PROJECT = { appId: 'example-app', appName: 'Example App', hasRoadmap: true, hasConcerns: false };

const renderCard = () => render(
  <MemoryRouter>
    <GsdProjectCard project={PROJECT} onRefresh={() => {}} />
  </MemoryRouter>,
);

// The Dashboard link used to render INSIDE the expand <button>. A <Link> is an
// <a>, and an <a> inside a <button> is invalid HTML that drops the link from the
// tab order — it also had to call stopPropagation to suppress the expand it
// should never have triggered. The two are siblings now.
describe('GsdProjectCard header row (nested-interactive regression)', () => {
  it('does not nest the Dashboard link inside the expand button', () => {
    const { container } = renderCard();
    const nested = [...container.querySelectorAll('button, a')]
      .filter((el) => el.querySelector('button, a'));
    expect(nested).toEqual([]);
  });

  it('keeps the Dashboard link focusable and pointing at the app', () => {
    renderCard();
    const link = screen.getByRole('link', { name: /dashboard/i });
    expect(link).toHaveAttribute('href', '/apps/example-app/gsd');
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it('still expands when the row itself is clicked', async () => {
    renderCard();
    fireEvent.click(screen.getByText('Example App'));
    expect(await screen.findByText('No phases found')).toBeInTheDocument();
  });
});
